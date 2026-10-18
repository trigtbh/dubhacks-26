const session = crypto.randomUUID();
const output = document.querySelector('#terminal-output');
const input = document.querySelector('#command');
const send = document.querySelector('#send');
const form = document.querySelector('#command-form');
const state = document.querySelector('#shell-state');
const terminal = document.querySelector('.terminal');
const consoleTitle = document.querySelector('#console-title');
const consoleKicker = document.querySelector('#console-kicker');
const consoleHint = document.querySelector('#console-hint');
let prompt = '>>> ';

function setStatus(label, status) {
  state.textContent = label;
  state.dataset.state = status;
  terminal.dataset.state = status;
}

const stream = new EventSource(`/events?session=${session}`);
stream.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === 'output') {
    output.textContent += event.text.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '');
    output.scrollTop = output.scrollHeight;
  } else if (event.type === 'ready') {
    prompt = event.prompt;
    const inPython = prompt.startsWith('>>> ') || prompt.startsWith('... ');
    input.disabled = false;
    send.disabled = false;
    input.placeholder = inPython ? 'Enter a Python expression' : 'Enter a shell command';
    send.textContent = inPython ? 'Run' : 'Send';
    consoleTitle.textContent = inPython ? 'Python console' : 'Bash shell';
    consoleKicker.textContent = inPython ? 'Python · worker-04' : 'Bash · worker-04';
    consoleHint.textContent = inPython ? 'Type exit() to move from Python to Bash.' : 'Type exit to close the session.';
    setStatus(inPython ? 'Python 3' : 'Bash', 'ready');
    terminal.setAttribute('aria-busy', 'false');
  } else if (event.type === 'error') {
    setStatus('attention', 'error');
    consoleHint.textContent = 'Restart the session to open a fresh shell.';
    output.textContent += `${event.message}\n`;
    output.scrollTop = output.scrollHeight;
    terminal.setAttribute('aria-busy', 'false');
    input.disabled = true;
    send.disabled = true;
  } else if (event.type === 'closed') {
    setStatus('closed', 'closed');
    consoleHint.textContent = 'The shell closed. Restart the session to begin again.';
    terminal.setAttribute('aria-busy', 'false');
    input.disabled = true;
    send.disabled = true;
  }
};
stream.onerror = () => {
  setStatus('reconnecting', 'reconnecting');
  consoleHint.textContent = 'The session stream was interrupted. Reconnecting...';
  input.placeholder = 'Reconnecting to the shell';
  terminal.setAttribute('aria-busy', 'true');
  input.disabled = true;
  send.disabled = true;
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const line = input.value;
  if (!line.trim() || input.disabled) return;
  input.disabled = true;
  send.disabled = true;
  setStatus('running', 'running');
  consoleHint.textContent = 'Waiting for command output.';
  input.placeholder = 'Waiting for the prompt';
  terminal.setAttribute('aria-busy', 'true');
  output.textContent += `${line}\n`;
  output.scrollTop = output.scrollHeight;
  input.value = '';
  try {
    const response = await fetch('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, line }),
    });
    if (!response.ok) {
      const message = await response.text();
      setStatus('attention', 'error');
      consoleHint.textContent = message;
      output.textContent += `${message}\n`;
      output.scrollTop = output.scrollHeight;
      terminal.setAttribute('aria-busy', 'false');
    }
  } catch {
    setStatus('connection lost', 'error');
    consoleHint.textContent = 'Connection lost. Restart the session before continuing.';
    terminal.setAttribute('aria-busy', 'false');
  }
});

document.querySelector('#reset').addEventListener('click', () => location.reload());

