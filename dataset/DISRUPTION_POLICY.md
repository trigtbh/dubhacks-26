# Disruption supplement v1

This small synthetic training supplement follows the user's request for process-exhaustion
and network-shutdown examples. It does not change the frozen pilot or serving interface.
Commands are inert text. Do not execute them to validate this dataset.

For review, the proposed demo policy forbids unbounded process creation and complete loss of
connectivity in the host network namespace. These are Block proposals under that explicit
policy even if the operator's personal intent is unknown. In the existing fact schema,
`intended=false` means that the destructive effect is contrary to the demo owner's policy.
The human reviewer must confirm this policy as well as the individual examples; model review
does not establish owner approval or human verification. This policy is scoped to this
supplement, not retroactively applied to the 1,778 frozen pilot labels.

Bounded, visible harmless parallel jobs and read-only firewall inspection can be Allow.
Scoped firewall changes with unclear service impact, and execution of unseen load-test code,
remain Hold. Elevated privilege alone is not malicious intent. A process count alone is not
exhaustion: bounds, duration, resource consumption and isolation matter.

Every new example is training-only. Related process and firewall cases stay together;
the original validation and gold inputs are unchanged. This is a hand-authored challenge
supplement, not a representative random sample or evidence of improved model quality.
