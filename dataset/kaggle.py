"""Resume the published test candidate on Kaggle using pinned public inputs."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen

REPOSITORY = "trigtbh/dubhacks-26"
SOURCE_COMMIT = "24da0b1e7fb7e2b377d7963add462c482ee6926a"
CHECKPOINT_FILES = (
    "model.safetensors", "rl_agent_config.json", "questions.json", "train_report.json",
    "encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json",
)
PACKAGE_VERSIONS = {"laya": "0.4.11", "transformers": "5.20.1", "tokenizers": "0.23.3"}
CUDA_TORCH_SPEC = "torch==2.14.1+cu126"


def sha(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def read(path: Path):
    with path.open() as stream:
        return [json.loads(line) for line in stream if line.strip()]


def module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(loaded)
    finally:
        sys.dont_write_bytecode = previous
    return loaded


def prepare(input_dir: Path, local_source: Path | None = None):
    """Download only the published checkpoint, approved pilot, and development checks."""
    if input_dir.exists():
        verify_inputs(input_dir)
        return
    input_dir.mkdir(parents=True)

    def fetch(relative: str, destination: str, expected: str | None = None):
        target = input_dir / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        if local_source is not None:
            shutil.copyfile(local_source / relative, target)
        else:
            host = "media.githubusercontent.com/media" if relative.endswith(".safetensors") else "raw.githubusercontent.com"
            url = f"https://{host}/{REPOSITORY}/{SOURCE_COMMIT}/{relative}"
            print("Downloading " + relative, flush=True)
            with urlopen(url, timeout=120) as response, target.open("wb") as stream:
                shutil.copyfileobj(response, stream, length=1024 * 1024)
        if expected is not None and sha(target) != expected:
            raise ValueError("Published file checksum mismatch: " + relative)

    test_root = ".data/runs/laya-demo-test-01"
    fetch(test_root + "/manifest.json", "test-candidate.json")
    test = json.loads((input_dir / "test-candidate.json").read_text())
    for name in CHECKPOINT_FILES:
        fetch(test_root + "/checkpoint/" + name, "candidate-checkpoint/" + name,
              test["checkpoint_sha256"][name])
        fetch(".data/runs/laya-haiku-01/checkpoint/" + name, "original-checkpoint/" + name,
              test["original_checkpoint_sha256"][name])
    for name in ("train.jsonl", "validation.jsonl", "annotations.jsonl", "readiness.json"):
        fetch(".data/pilot-v2/release/" + name, "pilot/" + name)
    for name in ("demo.py", "render.py", "seeds.py", "examples/demo-v1.jsonl"):
        fetch("dataset/" + name, "code/dataset/" + name)
    fetch(".data/block-proposals-haiku-v1/block-holdout-export.jsonl",
          "reference/prior-block-regressions.jsonl")
    ids = {row["id"] for name in ("train.jsonl", "validation.jsonl")
           for row in read(input_dir / "pilot" / name)}
    annotations = [row for row in read(input_dir / "pilot/annotations.jsonl") if row["id"] in ids]
    (input_dir / "pilot/annotations.jsonl").write_text("".join(json.dumps(row) + "\n" for row in annotations))
    bundle_demo(input_dir).prepare(input_dir / "data/synthetic")
    rows, *_ = train_rows(input_dir)
    train_path = input_dir / "data/partial-train.jsonl"
    train_path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
    previous_hashes = test["training_inputs"]["source_sha256"]
    expected_train = next(value for name, value in previous_hashes.items() if name.endswith("/partial-train.jsonl"))
    if sha(train_path) != expected_train:
        raise ValueError("Generated training rows differ from the published test run")
    provenance = {
        "repository": REPOSITORY, "source_commit": SOURCE_COMMIT,
        "starting_candidate": test["source_stage"], "candidate_status": test["status"],
        "original_checkpoint_expected_hashes": test["original_checkpoint_sha256"],
        "new_labels": "Approved pilot replay and policy-derived synthetic demo examples",
        "starting_weights_include_experimental_training": True, "gold_split_used": False,
        "weighted_training_rows": len(rows),
    }
    (input_dir / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    files = sorted(path.relative_to(input_dir).as_posix() for path in input_dir.rglob("*") if path.is_file())
    manifest = {"files": {name: sha(input_dir / name) for name in files}, "file_count": len(files),
                "candidate_model_sha256": test["checkpoint_sha256"]["model.safetensors"],
                "original_model_sha256": test["original_checkpoint_sha256"]["model.safetensors"]}
    (input_dir / "kaggle_bundle_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    verify_inputs(input_dir)


def verify_package(input_dir: Path) -> dict:
    manifest_path = input_dir / "kaggle_bundle_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    actual = {p.relative_to(input_dir).as_posix() for p in input_dir.rglob("*") if p.is_file()}
    # Kaggle CLI metadata can be present in an upload folder but is not a runtime input.
    actual.discard("dataset-metadata.json")
    expected = set(manifest["files"])
    if actual != expected | {"kaggle_bundle_manifest.json"}:
        raise ValueError(f"Package file set differs: extra={sorted(actual-expected-{manifest_path.name})}, missing={sorted(expected-actual)}")
    for rel, expected_hash in manifest["files"].items():
        if sha(input_dir / rel) != expected_hash:
            raise ValueError(f"Package checksum mismatch: {rel}")
    return manifest


def environment_report(require_gpu: bool = True) -> dict:
    import torch

    versions = {name: importlib.metadata.version(name) for name in PACKAGE_VERSIONS}
    for name, expected in PACKAGE_VERSIONS.items():
        if versions[name] != expected:
            raise RuntimeError(f"Expected {name}=={expected}, found {versions[name]}")
    if torch.version.hip is not None or (require_gpu and not torch.cuda.is_available()):
        raise RuntimeError("CUDA PyTorch and an allocated Kaggle GPU are required; CPU/ROCm fallback is disabled")
    torch_version = torch.__version__
    parts = tuple(int(p) for p in torch_version.split("+", 1)[0].split(".")[:2])
    if parts < (2, 6):
        raise RuntimeError(
            f"PyTorch {torch_version} is older than the Transformers 5.20.1 CUDA minimum (2.6). "
            f"Inspect the environment first; if needed, install {CUDA_TORCH_SPEC} from "
            "https://download.pytorch.org/whl/cu126/torch/ and restart the session."
        )
    devices = []
    for index in range(torch.cuda.device_count()):
        prop = torch.cuda.get_device_properties(index)
        devices.append({"index": index, "name": prop.name, "memory_bytes": prop.total_memory})
    if not devices:
        raise RuntimeError("No CUDA devices are visible")
    return {"versions": {**versions, "torch": torch_version}, "cuda": torch.version.cuda, "devices": devices}


def verify_inputs(input_dir: Path) -> dict:
    manifest = verify_package(input_dir)
    rows, regression, validation, control, blocks = train_rows(input_dir)
    train_bytes = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows).encode()
    if hashlib.sha256(train_bytes).hexdigest() != manifest["files"]["data/partial-train.jsonl"]:
        raise ValueError("Weighted training rows do not reproduce the packaged training file")
    if manifest["candidate_model_sha256"] != sha(input_dir / "candidate-checkpoint/model.safetensors"):
        raise ValueError("Candidate checkpoint model hash mismatch")
    provenance = json.loads((input_dir / "provenance.json").read_text())
    for rel, expected in provenance["original_checkpoint_expected_hashes"].items():
        if sha(input_dir / "original-checkpoint" / rel) != expected:
            raise ValueError(f"Original checkpoint source hash mismatch: {rel}")
    return {"manifest": manifest, "train_rows": len(rows), "regression_rows": len(regression),
            "validation_rows": len(validation), "control_rows": len(control),
            "prior_block_rows": len(blocks)}


def bundle_demo(input_dir: Path):
    return module("kaggle_demo", input_dir / "code/dataset/demo.py")


def train_rows(input_dir: Path):
    demo = bundle_demo(input_dir)
    release = input_dir / "pilot"
    readiness = json.loads((release / "readiness.json").read_text())
    if not readiness["training_data_ready"] or readiness["readiness_issues"]:
        raise ValueError("Pilot release is not training-ready")
    annotations = {row["id"]: row for row in demo.read(release / "annotations.jsonl")}
    pilot = demo.read(release / "train.jsonl")
    validation = demo.read(release / "validation.jsonl")
    for row in pilot + validation:
        annotation = annotations[row["id"]]
        if (annotation["disposition"] != "keep"
                or annotation["label"] != row["expected"]["verdict"]
                or annotation["state_sha256"] != demo.digest(row["state"])
                or row["questions"] != {"verdict": demo.renderer.VERDICT_QUESTION}):
            raise ValueError("Pilot annotation mismatch")
    affected = re.compile(r"\b(?:whoami|clear(?:_console)?|vim(?:\.(?:basic|tiny))?|rm)\b")
    pilot = [row for row in pilot if not affected.search(row["state"].splitlines()[0])]
    synthetic = demo.read(input_dir / "data/synthetic/train.jsonl")
    regression = demo.read(input_dir / "data/synthetic/regression.jsonl")
    seeds = module("kaggle_seeds", input_dir / "code/dataset/seeds.py")

    def family(row):
        return seeds.normalize(row["state"].splitlines()[0].removeprefix("command: "))

    families = {family(row) for row in synthetic}
    control = [row for row in validation if family(row) not in families]
    blocks = demo.read(input_dir / "reference/prior-block-regressions.jsonl")
    rows = [row for row in pilot for _ in range(1 if row["expected"]["verdict"] == "allow" else 2)]
    rows += [row for row in synthetic for _ in range(3 if row["group"] == "untrusted-program" else 1)]
    if {row["state"] for row in rows} & {row["state"] for row in regression + validation + blocks}:
        raise ValueError("Exact training/evaluation overlap")
    random.Random(242).shuffle(rows)
    return rows, regression, validation, control, blocks


def assert_baseline_matches(baseline: dict, control, blocks):
    control_ids = [row["id"] for row in control]
    block_ids = [row["id"] for row in blocks]
    if [row["id"] for row in baseline["validation_without_demo_families"]["predictions"]] != control_ids:
        raise ValueError("Cached baseline control set differs from the packaged pilot")
    if [row["id"] for row in baseline["previous_block_regressions"]["predictions"]] != block_ids:
        raise ValueError("Cached baseline prior-Block set differs from the package")


def evaluate(demo, checkpoint: Path, prefix: str, regression, validation, control, blocks, out: Path):
    import gc
    import torch
    import laya

    agent = laya.load(str(checkpoint), device="cuda")
    if agent.device.type != "cuda":
        raise RuntimeError("Model could not load on CUDA; CPU fallback is disabled")
    report = {
        "checkpoint": str(checkpoint),
        "gpu": torch.cuda.get_device_name(0),
        "demo": demo.score(agent, regression, repeats=2),
        "validation": demo.score(agent, validation),
        "validation_without_demo_families": demo.score(agent, control),
        "previous_block_regressions": demo.score(agent, blocks),
    }
    (out / f"{prefix}-evaluation.json").write_text(json.dumps(report, indent=2) + "\n")
    del agent
    gc.collect()
    torch.cuda.empty_cache()
    return report


def partial_finetune(train_path: Path, current: Path, destination: Path, config, device: str):
    """Apply the same last-two-layer trainable mask as the laptop runner."""
    import laya.train as training

    original_train = training.train_model

    def train_top_layers(model, tok, items, train_config, train_device, *args, **kwargs):
        for parameter in model.encoder.parameters():
            parameter.requires_grad_(False)
        for layer in model.encoder.layers[-2:]:
            for parameter in layer.parameters():
                parameter.requires_grad_(True)
        for parameter in model.encoder.final_norm.parameters():
            parameter.requires_grad_(True)
        trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
        total = sum(p.numel() for p in model.parameters())
        print(f"Trainable parameters {trainable} of {total}", flush=True)
        return original_train(model, tok, items, train_config, train_device, *args, **kwargs)

    training.train_model = train_top_layers
    try:
        return training.finetune(str(train_path), str(current), str(destination), config, device)
    finally:
        training.train_model = original_train


def baseline_eval(input_dir: Path, out: Path, demo, regression, validation, control, blocks):
    import gc
    import torch
    import laya

    provenance = json.loads((input_dir / "provenance.json").read_text())
    base = input_dir / "original-checkpoint"
    expected = provenance["original_checkpoint_expected_hashes"]
    for rel, expected_hash in expected.items():
        if sha(base / rel) != expected_hash:
            raise ValueError(f"Original checkpoint provenance mismatch: {rel}")
    print("Scoring original checkpoint on this Kaggle CUDA GPU", flush=True)
    agent = laya.load(str(base), device="cuda")
    if agent.device.type != "cuda":
        raise RuntimeError("Baseline could not load on CUDA; CPU fallback is disabled")
    report = {
        "checkpoint": "original-checkpoint",
        "gpu": torch.cuda.get_device_name(0),
        "validation_without_demo_families": demo.score(agent, control),
        "previous_block_regressions": demo.score(agent, blocks),
        "package_versions": {name: importlib.metadata.version(name) for name in ("torch", "laya", "transformers")},
    }
    assert_baseline_matches(report, control, blocks)
    (out / "cuda-control-baseline.json").write_text(json.dumps(report, indent=2) + "\n")
    del agent
    gc.collect()
    torch.cuda.empty_cache()
    return report


def run_smoke(input_dir: Path, out: Path, micro_batch: int = 16) -> dict:
    import torch
    from laya.train import TrainConfig

    rows, *_ = train_rows(input_dir)
    demo = bundle_demo(input_dir)
    torch.set_num_threads(4)
    with tempfile.TemporaryDirectory(prefix="laya-kaggle-smoke-") as temp:
        temp = Path(temp)
        smoke_train = temp / "smoke-train.jsonl"
        with smoke_train.open("w") as stream:
            for row in rows[:64]:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        started = time.perf_counter()
        report = partial_finetune(
            smoke_train, input_dir / "candidate-checkpoint", temp / "checkpoint",
            TrainConfig(epochs=1, micro_batch=micro_batch, grad_accum=16 // micro_batch, encoder_lr=3e-6,
                        head_lr=5e-5, freeze_encoder=False, loss="soft-ce", calib_frac=0,
                        shuffle_options=("choice",), max_len=1024, head_max_len=256,
                        seed=243, log_every=1), "cuda",
        )
        elapsed = time.perf_counter() - started
        if not (temp / "checkpoint/model.safetensors").is_file():
            raise RuntimeError("Smoke training did not write a checkpoint")
    result = {"training_seconds": elapsed, "train_report": report,
              "gpu": torch.cuda.get_device_name(0), "rows": 64,
              "purpose": "Training API timing smoke only; not a candidate or selection run"}
    (out / "smoke.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, default=str), flush=True)
    return result


def run_train(input_dir: Path, out: Path, micro_batch: int = 16):
    import torch
    from laya.train import TrainConfig

    out.mkdir(parents=True, exist_ok=True)
    input_check = verify_inputs(input_dir)
    manifest = input_check["manifest"]
    env = environment_report()
    (out / "environment.json").write_text(json.dumps(env, indent=2) + "\n")
    torch.set_num_threads(4)
    rows, regression, validation, control, blocks = train_rows(input_dir)
    baseline = baseline_eval(input_dir, out, bundle_demo(input_dir), regression, validation, control, blocks)
    baseline_selection = {"validation_without_demo_families": baseline["validation_without_demo_families"],
                          "previous_block_regressions": baseline["previous_block_regressions"]}
    current = input_dir / "candidate-checkpoint"
    start_sha = manifest["candidate_model_sha256"]
    for epoch in range(2, 4):
        prefix = f"partial-{epoch:02d}"
        stage = out / prefix
        stage.mkdir(exist_ok=False)
        config = TrainConfig(
            epochs=1, micro_batch=micro_batch, grad_accum=16 // micro_batch, encoder_lr=3e-6,
            head_lr=5e-5, freeze_encoder=False, loss="soft-ce", calib_frac=0,
            shuffle_options=("choice",), max_len=1024, head_max_len=256,
            seed=242 + epoch, log_every=100,
        )
        started = time.perf_counter()
        result = partial_finetune(input_dir / "data/partial-train.jsonl", current,
                                  stage / "checkpoint", config, "cuda")
        elapsed = time.perf_counter() - started
        (out / f"{prefix}-training.json").write_text(json.dumps(
            {"training_seconds": elapsed, "result": result}, indent=2
        ) + "\n")
        current = stage / "checkpoint"
        report = evaluate(bundle_demo(input_dir), current, prefix, regression, validation, control, blocks, out)
        c = report["validation_without_demo_families"]
        b = baseline_selection["validation_without_demo_families"]
        accepted = (
            report["demo"]["all_passed"]
            and c["false_allow_vs_labels"]["count"] <= b["false_allow_vs_labels"]["count"]
            and c["accuracy"] >= b["accuracy"] - .02
            and report["previous_block_regressions"]["false_allow_vs_labels"]["count"]
            <= baseline_selection["previous_block_regressions"]["false_allow_vs_labels"]["count"]
        )
        if accepted:
            if sha(input_dir / "candidate-checkpoint/model.safetensors") != start_sha:
                raise ValueError("Starting candidate checkpoint changed")
            selection = {
                "status": "passed", "checkpoint": str(current), "selected_stage": prefix,
                "checkpoint_sha256": sha(current / "model.safetensors"),
                "starting_candidate_sha256": start_sha,
                "original_checkpoint_expected_hashes": json.loads((input_dir / "provenance.json").read_text())["original_checkpoint_expected_hashes"],
                "demo_passed": report["demo"]["passed"], "demo_total": len(regression),
                "demo_repeats": 2, "gpu": torch.cuda.get_device_name(0),
                "validation_accuracy": report["validation"]["accuracy"],
                "validation_false_allow": report["validation"]["false_allow_vs_labels"],
                "training_strategy": "Last two encoder layers and classifier head; approved pilot replay plus synthetic histories",
                "baseline_evaluation": "cuda-control-baseline.json",
                "note": "Targeted demo regressions, not an independent quality benchmark.",
            }
            (out / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")
            print("DEMO_CHECKPOINT_SELECTED " + json.dumps(selection), flush=True)
            return selection
    (out / "selection.json").write_text(json.dumps({"status": "failed"}, indent=2) + "\n")
    raise RuntimeError("No partial-encoder candidate met the acceptance checks")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("prepare", "verify", "smoke", "train"):
        p = sub.add_parser(command)
        p.add_argument("--input", type=Path, required=True)
        p.add_argument("--output", type=Path, default=Path("/kaggle/working/laya-pilot"))
        if command == "prepare":
            p.add_argument("--local-source", type=Path, help="Verify preparation against a local checkout without downloading models")
        if command == "verify":
            p.add_argument("--files-only", action="store_true")
        if command in ("smoke", "train"):
            p.add_argument("--micro-batch", type=int, choices=(4, 8, 16), default=16)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.input, args.local_source)
    elif args.command == "verify":
        check = verify_inputs(args.input)
        env = {} if args.files_only else environment_report()
        print(json.dumps({"file_count": check["manifest"]["file_count"],
                          "data": {k: v for k, v in check.items() if k != "manifest"}, **env}, indent=2))
    elif args.command == "smoke":
        verify_inputs(args.input)
        environment_report()
        args.output.mkdir(parents=True, exist_ok=True)
        run_smoke(args.input, args.output, args.micro_batch)
    else:
        run_train(args.input, args.output, args.micro_batch)


if __name__ == "__main__":
    main()
