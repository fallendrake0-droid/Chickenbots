import { state, botNames, runCommand } from './store.js';
import { openModal, toast, resultMessage, setButtonLoading } from './ui.js';
import { esc } from './utils.js';

export function openAssignDialog(task) {
  const names = botNames();
  if (!names.length) {
    toast({ type: 'warn', title: 'No bots available', message: 'The runtime has not reported any bots yet.' });
    return;
  }
  openModal({
    title: `Assign ${task.label || task.type}`,
    description: 'Claiming a task forces assignment, even if another bot currently holds it.',
    body: `
      <div class="field">
        <label class="field-label" for="assign-bot">Bot</label>
        <select class="select" id="assign-bot">${names.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select>
      </div>
      <div class="kv" style="margin-top:12px">
        <div class="kv-row"><span class="kv-key">Task ID</span><span class="kv-value mono">${esc(task.id)}</span></div>
        <div class="kv-row"><span class="kv-key">Status</span><span class="kv-value">${esc(task.status)}</span></div>
        <div class="kv-row"><span class="kv-key">Current owner</span><span class="kv-value">${esc(task.claimedBy || 'unclaimed')}</span></div>
      </div>`,
    footer: `<button class="button" type="button" data-cancel>Cancel</button><button class="button button--primary" type="button" data-confirm>Assign task</button>`,
    onMount: (modal, closeDialog) => {
      modal.querySelector('[data-cancel]').addEventListener('click', closeDialog);
      modal.querySelector('[data-confirm]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        setButtonLoading(button, true);
        try {
          const result = await runCommand(`task assign ${task.id} ${modal.querySelector('#assign-bot').value}`);
          const message = resultMessage(result);
          toast({ type: message.type, title: message.title, message: message.message });
          closeDialog();
        } catch (err) {
          toast({ type: 'error', title: 'Assignment failed', message: err.message });
          setButtonLoading(button, false);
        }
      });
    }
  });
}

export function openPriorityDialog(task) {
  openModal({
    title: `Reprioritise ${task.label || task.type}`,
    description: 'Lower numbers are scheduled first. The task board accepts 0–100.',
    body: `
      <div class="field">
        <label class="field-label" for="priority-value">Priority</label>
        <input class="input" id="priority-value" type="number" min="0" max="100" step="1" value="${esc(task.priority ?? 50)}" autofocus>
      </div>`,
    footer: `<button class="button" type="button" data-cancel>Cancel</button><button class="button button--primary" type="button" data-confirm>Save priority</button>`,
    onMount: (modal, closeDialog) => {
      modal.querySelector('[data-cancel]').addEventListener('click', closeDialog);
      modal.querySelector('[data-confirm]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const value = modal.querySelector('#priority-value').value;
        setButtonLoading(button, true);
        try {
          const result = await runCommand(`task priority ${task.id} ${value}`);
          const message = resultMessage(result);
          toast({ type: message.type, title: message.title, message: message.message });
          closeDialog();
        } catch (err) {
          toast({ type: 'error', title: 'Priority update failed', message: err.message });
          setButtonLoading(button, false);
        }
      });
    }
  });
}

export function findTask(id) {
  return ((state.snapshot && state.snapshot.taskManager && state.snapshot.taskManager.tasks) || []).find((task) => String(task.id) === String(id));
}

export function openCreateDialog() {
  const types = state.taskTypes.length ? state.taskTypes : ['CHOP_WOOD', 'MINE_ORE', 'FARM_CROP', 'EXPLORE', 'RETURN_HOME'];
  openModal({
    title: 'Create task',
    description: 'New tasks enter the board as PENDING and are picked up by the coordinator.',
    body: `
      <div class="form-grid">
        <div class="field">
          <label class="field-label" for="task-type">Task type</label>
          <select class="select" id="task-type">${types.map((type) => `<option value="${esc(type)}">${esc(type.replace(/_/g, ' ').toLowerCase())}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label class="field-label" for="task-label">Label</label>
          <input class="input" id="task-label" type="text" maxlength="120" placeholder="Optional description">
        </div>
      </div>
      <p class="tiny muted" style="margin:10px 0 0">Priority defaults to 50. You can reprioritise from the task board afterwards.</p>`,
    footer: `<button class="button" type="button" data-cancel>Cancel</button><button class="button button--primary" type="button" data-confirm>${'Create task'}</button>`,
    onMount: (modal, closeDialog) => {
      modal.querySelector('[data-cancel]').addEventListener('click', closeDialog);
      modal.querySelector('[data-confirm]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const type = modal.querySelector('#task-type').value;
        const label = modal.querySelector('#task-label').value.trim();
        setButtonLoading(button, true);
        try {
          const result = await runCommand(`task add ${type}${label ? ` ${label}` : ''}`);
          const message = resultMessage(result);
          toast({ type: message.type, title: message.title, message: message.message });
          closeDialog();
        } catch (err) {
          toast({ type: 'error', title: 'Task creation failed', message: err.message });
          setButtonLoading(button, false);
        }
      });
    }
  });
}


export function openObjectiveDialog() {
  openModal({
    title: 'Create objective',
    description: 'Objectives group related tasks and are tracked on the team board.',
    body: `
      <div class="field">
        <label class="field-label" for="objective-title">Objective title</label>
        <input class="input" id="objective-title" type="text" maxlength="120" placeholder="e.g. Secure a permanent food supply" autofocus>
      </div>`,
    footer: `<button class="button" type="button" data-cancel>Cancel</button><button class="button button--primary" type="button" data-confirm>Create objective</button>`,
    onMount: (modal, closeDialog) => {
      modal.querySelector('[data-cancel]').addEventListener('click', closeDialog);
      modal.querySelector('[data-confirm]').addEventListener('click', async (event) => {
        const title = modal.querySelector('#objective-title').value.trim();
        if (!title) {
          toast({ type: 'warn', title: 'Title required', message: 'Enter an objective title.' });
          return;
        }
        const button = event.currentTarget;
        setButtonLoading(button, true);
        try {
          const result = await runCommand(`task objective ${title}`);
          const message = resultMessage(result);
          toast({ type: message.type, title: message.title, message: message.message });
          closeDialog();
        } catch (err) {
          toast({ type: 'error', title: 'Objective creation failed', message: err.message });
          setButtonLoading(button, false);
        }
      });
    }
  });
}
