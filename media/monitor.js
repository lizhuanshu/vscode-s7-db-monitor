(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    blocks: [],
    activeDbId: undefined,
    selectedVariableId: undefined,
    continuousBlockId: undefined,
    values: {},
    expanded: {},
    writeRadix: 10,
    boolPulseMs: 500,
    operationFeedback: undefined,
    options: {
      host: '192.168.0.1',
      rack: 0,
      slot: 1,
      pollIntervalMs: 1000
    },
    status: {
      state: 'disconnected',
      message: 'Disconnected'
    }
  };
  const blockCaches = new Map();

  const els = {
    host: document.getElementById('host'),
    rack: document.getElementById('rack'),
    slot: document.getElementById('slot'),
    pollIntervalMs: document.getElementById('pollIntervalMs'),
    connect: document.getElementById('connect'),
    disconnect: document.getElementById('disconnect'),
    sidebar: document.getElementById('sidebar'),
    sidebarResizer: document.getElementById('sidebarResizer'),
    tabs: document.getElementById('tabs'),
    dbInfo: document.getElementById('dbInfo'),
    variables: document.getElementById('variables'),
    variableOps: document.getElementById('variableOps'),
    empty: document.getElementById('empty'),
    statusState: document.getElementById('statusState'),
    statusMessage: document.getElementById('statusMessage'),
    statusStats: document.getElementById('statusStats'),
    variablesTable: document.getElementById('variablesTable')
  };
  const persisted = vscode.getState() || {};
  state.sidebarWidth = clampSidebarWidth(persisted.sidebarWidth || 280);
  state.boolPulseMs = clampPulseMs(persisted.boolPulseMs || state.boolPulseMs);
  state.columnWidths = {
    name: persisted.columnWidths?.name,
    type: persisted.columnWidths?.type,
    address: persisted.columnWidths?.address,
    value: persisted.columnWidths?.value,
    comment: persisted.columnWidths?.comment
  };
  state.columnOrder = ['name', 'type', 'address', 'value', 'comment'];

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      state.blocks = message.blocks || [];
      rebuildBlockCaches();
      state.options = message.options || state.options;
      state.status = message.status || state.status;
      state.continuousBlockId = message.continuousBlockId;
      if (!state.blocks.some((block) => block.id === state.activeDbId)) {
        state.activeDbId = state.blocks[0] && state.blocks[0].id;
        state.selectedVariableId = undefined;
      }
      ensureSelectedVariable();
      applyOptions();
      render();
      return;
    }
    if (message.type === 'status') {
      const previousState = state.status.state;
      state.status = message.status;
      renderStatus();
      if (previousState !== state.status.state) {
        renderDbInfo();
      }
      applyWriteStatusFeedback(message.status);
      return;
    }
    if (message.type === 'values') {
      const update = message.update;
      state.values[update.dbId] = update.values;
      if (update.dbId === state.activeDbId) {
        updateVariableValues();
      }
      renderStatus(update.updatedAt);
    }
  });

  els.connect.addEventListener('click', () => {
    vscode.postMessage({
      type: 'connect',
      options: readOptions()
    });
  });
  els.disconnect.addEventListener('click', () => vscode.postMessage({ type: 'disconnect' }));
  for (const input of [els.host, els.rack, els.slot, els.pollIntervalMs]) {
    input.addEventListener('change', () => {
      vscode.postMessage({
        type: 'saveConnectionOptions',
        options: readOptions()
      });
    });
  }
  els.sidebarResizer.addEventListener('pointerdown', startSidebarResize);
  setupColumnResizing();

  vscode.postMessage({ type: 'ready' });
  applySidebarLayout();
  applyColumnWidths();

  function applyOptions() {
    applyInputValue(els.host, state.options.host);
    applyInputValue(els.rack, String(state.options.rack));
    applyInputValue(els.slot, String(state.options.slot));
    applyInputValue(els.pollIntervalMs, String(state.options.pollIntervalMs));
  }

  function applyInputValue(input, value) {
    if (document.activeElement === input && isTextEditingElement(input)) {
      return;
    }
    if (input.value !== value) {
      input.value = value;
    }
  }

  function isEditingInside(container) {
    const active = document.activeElement;
    return Boolean(active && container.contains(active) && isTextEditingElement(active));
  }

  function isTextEditingElement(element) {
    if (element.tagName === 'TEXTAREA') {
      return true;
    }
    if (element.tagName === 'SELECT') {
      return true;
    }
    if (element.tagName !== 'INPUT') {
      return false;
    }
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type);
  }

  function readOptions() {
    return {
      host: els.host.value.trim(),
      rack: numberOrDefault(els.rack.value, 0),
      slot: numberOrDefault(els.slot.value, 1),
      pollIntervalMs: numberOrDefault(els.pollIntervalMs.value, 1000)
    };
  }

  function numberOrDefault(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function startSidebarResize(event) {
    event.preventDefault();
    els.sidebarResizer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-sidebar');

    const onMove = (moveEvent) => {
      state.sidebarWidth = clampSidebarWidth(moveEvent.clientX);
      applySidebarLayout();
    };
    const onUp = (upEvent) => {
      els.sidebarResizer.releasePointerCapture(upEvent.pointerId);
      document.body.classList.remove('resizing-sidebar');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      persistUiState();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function applySidebarLayout() {
    document.documentElement.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);
  }

  function persistUiState() {
    vscode.setState({
      sidebarWidth: state.sidebarWidth,
      boolPulseMs: state.boolPulseMs,
      columnWidths: state.columnWidths
    });
  }

  function setupColumnResizing() {
    if (!els.variablesTable) {
      return;
    }

    for (const handle of els.variablesTable.querySelectorAll('.column-resizer')) {
      handle.addEventListener('pointerdown', startColumnResize);
    }
  }

  function startColumnResize(event) {
    event.preventDefault();
    event.stopPropagation();

    const th = event.currentTarget?.parentElement;
    const columnId = th?.dataset.columnId;
    if (!th || !columnId) {
      return;
    }

    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    const minWidths = {
      name: 120,
      type: 80,
      address: 80,
      value: 100,
      comment: 120
    };

    th.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-column');

    const onMove = (moveEvent) => {
      const nextWidth = Math.max(minWidths[columnId] || 80, Math.round(startWidth + (moveEvent.clientX - startX)));
      state.columnWidths[columnId] = nextWidth;
      applyColumnWidths();
    };
    const onUp = (upEvent) => {
      th.releasePointerCapture(upEvent.pointerId);
      document.body.classList.remove('resizing-column');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      persistUiState();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function applyColumnWidths() {
    if (!els.variablesTable) {
      return;
    }

    let totalWidth = 0;
    for (const columnId of state.columnOrder) {
      const width = state.columnWidths[columnId];
      const col = els.variablesTable.querySelector(`col.column-${columnId}`);
      if (col) {
        const appliedWidth = width || defaultColumnWidth(columnId);
        col.style.width = `${appliedWidth}px`;
        totalWidth += appliedWidth;
      }
    }
    els.variablesTable.style.width = `${Math.max(totalWidth, 860)}px`;
  }

  function defaultColumnWidth(columnId) {
    const widths = {
      name: 320,
      type: 180,
      address: 120,
      value: 180,
      comment: 260
    };
    return widths[columnId] || 160;
  }

  function clampSidebarWidth(width) {
    return Math.min(Math.max(Number(width) || 280, 180), 520);
  }

  function clampPulseMs(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return 500;
    }
    return Math.min(Math.max(Math.round(number), 0), 600000);
  }

  function render() {
    applySidebarLayout();
    renderTabs();
    renderDbInfo();
    renderVariables();
    renderVariableOps();
    renderStatus();
  }

  function renderTabs() {
    els.tabs.textContent = '';
    const fragment = document.createDocumentFragment();
    for (const block of state.blocks) {
      const tab = document.createElement('div');
      tab.className = block.id === state.activeDbId ? 'db-list-item active' : 'db-list-item';
      tab.title = block.name;

      const button = document.createElement('button');
      button.className = 'db-list-select';
      button.addEventListener('click', () => {
        state.activeDbId = block.id;
        state.selectedVariableId = undefined;
        state.operationFeedback = undefined;
        render();
      });

      const name = document.createElement('span');
      name.className = 'db-list-name';
      name.textContent = block.name;
      button.appendChild(name);

      tab.appendChild(button);

      const numberWrap = document.createElement('label');
      numberWrap.className = 'db-list-number';
      numberWrap.title = 'DB block number used for PLC reads';
      numberWrap.textContent = 'DB';

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.max = '65535';
      input.step = '1';
      input.value = block.number === undefined ? '' : String(block.number);
      input.placeholder = '?';
      input.addEventListener('click', (event) => event.stopPropagation());
      input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          input.blur();
        }
      });
      input.addEventListener('change', () => {
        const parsed = parseDbNumber(input.value);
        vscode.postMessage({
          type: 'setDbNumber',
          dbId: block.id,
          number: parsed
        });
      });
      numberWrap.appendChild(input);
      tab.appendChild(numberWrap);

      fragment.appendChild(tab);
    }
    els.tabs.appendChild(fragment);
  }

  function renderDbInfo() {
    els.dbInfo.textContent = '';
    const block = activeBlock();
    if (!block) {
      els.dbInfo.classList.add('hidden');
      return;
    }

    els.dbInfo.classList.remove('hidden');
    const identity = document.createElement('div');
    identity.className = 'db-identity';
    identity.appendChild(infoItem('Block', block.name, 'wide'));
    identity.appendChild(infoItem('Number', block.number === undefined ? 'Not set' : `DB${block.number}`));
    identity.appendChild(infoItem('Read size', `${block.readSize} bytes`));
    identity.appendChild(infoItem('Variables', String(blockCache(block).variableCount)));
    els.dbInfo.appendChild(identity);

    const actions = document.createElement('div');
    actions.className = 'db-actions';
    if (block.diagnostics && block.diagnostics.length > 0) {
      const notice = document.createElement('span');
      notice.className = 'db-notice';
      notice.textContent = `Parse warnings: ${block.diagnostics.length}`;
      notice.title = block.diagnostics.join('\n');
      actions.appendChild(notice);
    }
    if (block.number === undefined) {
      const notice = document.createElement('span');
      notice.className = 'db-notice';
      notice.textContent = 'DB number not set';
      notice.title = 'Set the DB block number before reading PLC data.';
      actions.appendChild(notice);
    }

    const hasExpandableNodes = blockCache(block).hasExpandableNodes;

    const expandAllButton = document.createElement('button');
    expandAllButton.textContent = 'Expand All';
    expandAllButton.disabled = !hasExpandableNodes;
    expandAllButton.title = hasExpandableNodes ? 'Expand all variable nodes' : 'No expandable nodes';
    expandAllButton.addEventListener('click', () => {
      setAllExpanded(block.variables, true);
      renderVariables();
    });
    actions.appendChild(expandAllButton);

    const collapseAllButton = document.createElement('button');
    collapseAllButton.textContent = 'Collapse All';
    collapseAllButton.disabled = !hasExpandableNodes;
    collapseAllButton.title = hasExpandableNodes ? 'Collapse all variable nodes' : 'No expandable nodes';
    collapseAllButton.addEventListener('click', () => {
      setAllExpanded(block.variables, false);
      renderVariables();
    });
    actions.appendChild(collapseAllButton);

    const readButton = document.createElement('button');
    readButton.textContent = 'Read Once';
    readButton.disabled = block.number === undefined || state.status.state !== 'connected';
    readButton.title = block.number === undefined ? 'Set DB number first' : 'Read this DB block once';
    readButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'readBlock', dbId: block.id });
    });
    actions.appendChild(readButton);

    const continuousLabel = document.createElement('label');
    continuousLabel.className = 'switch';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.continuousBlockId === block.id;
    checkbox.disabled = block.number === undefined || state.status.state !== 'connected';
    checkbox.addEventListener('change', () => {
      vscode.postMessage({
        type: 'setContinuousRead',
        dbId: block.id,
        enabled: checkbox.checked
      });
    });
    continuousLabel.appendChild(checkbox);
    continuousLabel.appendChild(document.createTextNode('Continuous'));
    actions.appendChild(continuousLabel);

    els.dbInfo.appendChild(actions);
  }

  function setAllExpanded(variables, expanded) {
    for (const variable of variables) {
      if (variable.children && variable.children.length > 0) {
        state.expanded[variable.id] = expanded;
        setAllExpanded(variable.children, expanded);
      }
    }
  }

  function infoItem(label, value, variant) {
    const item = document.createElement('span');
    item.className = variant === 'wide' ? 'info-item wide' : 'info-item';

    const key = document.createElement('span');
    key.className = 'info-key';
    key.textContent = label;
    item.appendChild(key);

    const val = document.createElement('span');
    val.className = 'info-value';
    val.textContent = value;
    item.appendChild(val);

    return item;
  }

  function parseDbNumber(value) {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const number = Number(trimmed);
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      return undefined;
    }
    return number;
  }

  function renderVariables() {
    els.variables.textContent = '';
    const block = activeBlock();
    const hasBlock = Boolean(block);
    els.empty.classList.toggle('hidden', hasBlock);
    if (!block) {
      state.selectedVariableId = undefined;
      return;
    }

    ensureSelectedVariable();
    const fragment = document.createDocumentFragment();
    for (const variable of block.variables) {
      renderVariableRow(variable, 0, fragment);
    }
    els.variables.appendChild(fragment);
  }

  function renderVariableRow(variable, level, target) {
    const tr = document.createElement('tr');
    tr.className = variable.id === state.selectedVariableId ? 'selected' : '';
    tr.title = variable.readable ? 'Select variable' : 'This variable is a container';
    tr.addEventListener('click', () => {
      state.selectedVariableId = variable.id;
      state.operationFeedback = undefined;
      renderVariables();
      renderVariableOps();
    });
    const nameCell = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'name-cell';

    const indent = document.createElement('span');
    indent.className = 'indent';
    indent.style.width = `${level * 18}px`;
    wrap.appendChild(indent);

    const hasChildren = variable.children && variable.children.length > 0;
    const toggle = document.createElement('button');
    toggle.className = hasChildren ? 'toggle' : 'toggle placeholder';
    toggle.textContent = hasChildren ? (isExpanded(variable.id) ? 'v' : '>') : '';
    toggle.title = hasChildren ? 'Toggle' : '';
    if (hasChildren) {
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        state.expanded[variable.id] = !isExpanded(variable.id);
        renderVariables();
        renderVariableOps();
      });
    }
    wrap.appendChild(toggle);

    const icon = document.createElement('span');
    icon.className = 'type-icon';
    wrap.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'name-text';
    text.textContent = variable.name;
    wrap.appendChild(text);

    nameCell.appendChild(wrap);
    tr.appendChild(nameCell);
    tr.appendChild(textCell(variable.type));
    tr.appendChild(textCell(formatAddress(variable)));

    const valueCell = textCell('');
    valueCell.dataset.valueId = variable.id;
    valueCell.classList.add('value');
    applyValueCell(valueCell, variable);
    tr.appendChild(valueCell);
    tr.appendChild(textCell(variable.comment || ''));
    target.appendChild(tr);

    if (hasChildren && isExpanded(variable.id)) {
      for (const child of variable.children) {
        renderVariableRow(child, level + 1, target);
      }
    }
  }

  function updateVariableValues() {
    const block = activeBlock();
    if (!block) {
      return;
    }

    const cache = blockCache(block);
    for (const cell of els.variables.querySelectorAll('[data-value-id]')) {
      const variable = cache.variableById.get(cell.dataset.valueId);
      if (variable) {
        applyValueCell(cell, variable);
      }
    }
    updateOperationCurrentValue();
  }

  function applyValueCell(cell, variable) {
    const text = formatValue(variable);
    cell.textContent = text;
    cell.title = text;
    cell.classList.remove('boolean-true', 'boolean-false');
    const value = currentValues()[variable.id];
    if (typeof value === 'boolean') {
      cell.classList.add(value ? 'boolean-true' : 'boolean-false');
    }
  }

  function updateOperationCurrentValue() {
    const element = els.variableOps.querySelector('[data-operation-current]');
    const variable = selectedVariable();
    if (!element || !variable) {
      return;
    }

    element.textContent = formatOperationValue(variable);
    element.title = element.textContent;
  }

  function renderVariableOps() {
    els.variableOps.textContent = '';
    const block = activeBlock();
    if (!block) {
      els.variableOps.classList.add('hidden');
      return;
    }

    els.variableOps.classList.remove('hidden');
    ensureSelectedVariable();
    const variable = selectedVariable();
    if (!variable) {
      els.variableOps.appendChild(operationNotice('Select a readable variable to operate.'));
      return;
    }

    const header = document.createElement('div');
    header.className = 'operation-summary';
    header.appendChild(infoItem('Variable', variable.path.join('.'), 'wide'));
    header.appendChild(infoItem('Type', variable.type));
    header.appendChild(infoItem('Address', formatAddress(variable)));
    const currentItem = infoItem('Current', formatOperationValue(variable));
    currentItem.querySelector('.info-value').dataset.operationCurrent = 'true';
    header.appendChild(currentItem);
    els.variableOps.appendChild(header);

    const feedbackWrap = document.createElement('div');
    feedbackWrap.className = currentOperationFeedback() ? 'operation-feedback-wrap' : 'operation-feedback-wrap hidden';
    feedbackWrap.appendChild(operationFeedbackElement());
    els.variableOps.appendChild(feedbackWrap);

    const controls = document.createElement('div');
    controls.className = 'operation-controls';
    const writable = writeKind(variable);
    const canWrite = block.number !== undefined && state.status.state === 'connected' && writable !== 'unsupported';

    if (block.number === undefined) {
      controls.appendChild(operationNotice('Set DB number before writing.'));
    } else if (state.status.state !== 'connected') {
      controls.appendChild(operationNotice('Connect PLC before writing.'));
    } else if (writable === 'unsupported') {
      controls.appendChild(operationNotice(`${variable.type} write is not supported.`));
    }

    if (writable === 'bool') {
      const writeBool = (value) => {
        setOperationFeedback('pending', `Writing ${value ? 'True' : 'False'}...`);
        vscode.postMessage({
          type: 'writeVariable',
          request: {
            dbId: block.id,
            variableId: variable.id,
            value
          }
        });
      };

      const falseButton = document.createElement('button');
      falseButton.textContent = 'False';
      falseButton.disabled = !canWrite;
      falseButton.addEventListener('click', () => writeBool(false));
      controls.appendChild(falseButton);

      const trueButton = document.createElement('button');
      trueButton.textContent = 'True';
      trueButton.disabled = !canWrite;
      trueButton.addEventListener('click', () => writeBool(true));
      controls.appendChild(trueButton);

      const pulseLabel = document.createElement('label');
      pulseLabel.className = 'operation-field compact pulse-field';
      pulseLabel.textContent = 'Pulse(ms)';
      const pulseInput = document.createElement('input');
      pulseInput.type = 'number';
      pulseInput.min = '0';
      pulseInput.max = '600000';
      pulseInput.step = '10';
      pulseInput.value = String(state.boolPulseMs);
      pulseInput.disabled = !canWrite;
      pulseInput.addEventListener('change', () => {
        const validation = validatePulseMs(pulseInput.value);
        if (validation) {
          setOperationFeedback('error', validation);
          return;
        }
        state.boolPulseMs = clampPulseMs(pulseInput.value);
        pulseInput.value = String(state.boolPulseMs);
        clearOperationFeedback();
        persistUiState();
      });
      pulseLabel.appendChild(pulseInput);
      controls.appendChild(pulseLabel);

      const pulse = (pattern) => {
        const validation = validatePulseMs(pulseInput.value);
        if (validation) {
          setOperationFeedback('error', validation);
          return;
        }
        state.boolPulseMs = clampPulseMs(pulseInput.value);
        pulseInput.value = String(state.boolPulseMs);
        persistUiState();
        setOperationFeedback('pending', `Pulsing ${pattern === 'false-true-false' ? 'F-T-F' : 'T-F-T'}...`);
        vscode.postMessage({
          type: 'pulseVariable',
          request: {
            dbId: block.id,
            variableId: variable.id,
            pattern,
            pulseMs: state.boolPulseMs
          }
        });
      };

      const falseTrueFalseButton = document.createElement('button');
      falseTrueFalseButton.textContent = 'F-T-F';
      falseTrueFalseButton.title = 'Write False, wait, True, wait, False';
      falseTrueFalseButton.disabled = !canWrite;
      falseTrueFalseButton.addEventListener('click', () => pulse('false-true-false'));
      controls.appendChild(falseTrueFalseButton);

      const trueFalseTrueButton = document.createElement('button');
      trueFalseTrueButton.textContent = 'T-F-T';
      trueFalseTrueButton.title = 'Write True, wait, False, wait, True';
      trueFalseTrueButton.disabled = !canWrite;
      trueFalseTrueButton.addEventListener('click', () => pulse('true-false-true'));
      controls.appendChild(trueFalseTrueButton);
    } else if (writable !== 'unsupported') {
      if (writable === 'integer') {
        const radixLabel = document.createElement('label');
        radixLabel.className = 'operation-field compact';
        radixLabel.textContent = 'Base';
        const select = document.createElement('select');
        for (const option of [
          ['10', 'Dec'],
          ['16', 'Hex'],
          ['2', 'Bin'],
          ['8', 'Oct']
        ]) {
          const opt = document.createElement('option');
          opt.value = option[0];
          opt.textContent = option[1];
          select.appendChild(opt);
        }
        select.value = String(state.writeRadix);
        select.addEventListener('change', () => {
          state.writeRadix = Number(select.value);
          renderVariableOps();
        });
        radixLabel.appendChild(select);
        controls.appendChild(radixLabel);
      }

      const valueLabel = document.createElement('label');
      valueLabel.className = 'operation-field';
      valueLabel.textContent = 'Value';
      const input = document.createElement('input');
      input.type = 'text';
      input.disabled = !canWrite;
      input.value = defaultWriteValue(variable, writable);
      input.placeholder = writePlaceholder(variable, writable);
      input.addEventListener('input', () => clearOperationFeedback());
      valueLabel.appendChild(input);
      controls.appendChild(valueLabel);

      const writeButton = document.createElement('button');
      writeButton.textContent = 'Write';
      writeButton.disabled = !canWrite;
      const write = () => {
        const validation = validateWriteValue(variable, writable, input.value);
        if (validation) {
          setOperationFeedback('error', validation);
          return;
        }
        setOperationFeedback('pending', 'Writing...');
        vscode.postMessage({
          type: 'writeVariable',
          request: {
            dbId: block.id,
            variableId: variable.id,
            value: input.value,
            radix: writable === 'integer' ? state.writeRadix : 10
          }
        });
      };
      writeButton.addEventListener('click', write);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !writeButton.disabled) {
          write();
        }
      });
      controls.appendChild(writeButton);
    }

    els.variableOps.appendChild(controls);
  }

  function operationNotice(text) {
    const notice = document.createElement('span');
    notice.className = 'operation-notice';
    notice.textContent = text;
    return notice;
  }

  function operationFeedbackElement() {
    const feedback = currentOperationFeedback();
    const item = document.createElement('span');
    item.className = feedback ? `operation-feedback ${feedback.kind}` : 'operation-feedback hidden';
    item.textContent = feedback ? feedback.message : '';
    return item;
  }

  function setOperationFeedback(kind, message) {
    const block = activeBlock();
    if (!block || !state.selectedVariableId) {
      return;
    }

    state.operationFeedback = {
      dbId: block.id,
      variableId: state.selectedVariableId,
      kind,
      message
    };
    renderOperationFeedback();
  }

  function clearOperationFeedback() {
    if (!currentOperationFeedback()) {
      return;
    }
    state.operationFeedback = undefined;
    renderOperationFeedback();
  }

  function currentOperationFeedback() {
    const feedback = state.operationFeedback;
    if (!feedback || feedback.dbId !== state.activeDbId || feedback.variableId !== state.selectedVariableId) {
      return undefined;
    }
    return feedback;
  }

  function renderOperationFeedback() {
    const element = els.variableOps.querySelector('.operation-feedback');
    if (!element) {
      return;
    }

    const feedback = currentOperationFeedback();
    element.parentElement?.classList.toggle('hidden', !feedback);
    element.className = feedback ? `operation-feedback ${feedback.kind}` : 'operation-feedback hidden';
    element.textContent = feedback ? feedback.message : '';
  }

  function applyWriteStatusFeedback(status) {
    const feedback = currentOperationFeedback();
    if (!feedback) {
      return;
    }

    const message = status.message || '';
    if (status.state === 'error') {
      if (feedback.kind === 'pending') {
        setOperationFeedback('error', message || 'Write failed.');
      }
      return;
    }
    if (status.state === 'connected' && /^Write completed:|^Pulse completed:/.test(message)) {
      setOperationFeedback('success', message);
    }
  }

  function textCell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    td.title = text;
    return td;
  }

  function activeBlock() {
    return state.blocks.find((block) => block.id === state.activeDbId);
  }

  function selectedVariable() {
    const block = activeBlock();
    if (!block || !state.selectedVariableId) {
      return undefined;
    }
    return blockCache(block).variableById.get(state.selectedVariableId);
  }

  function ensureSelectedVariable() {
    const block = activeBlock();
    if (!block) {
      state.selectedVariableId = undefined;
      return;
    }

    const cache = blockCache(block);
    if (state.selectedVariableId && cache.variableById.has(state.selectedVariableId)) {
      return;
    }

    state.selectedVariableId = cache.firstReadableId;
  }

  function rebuildBlockCaches() {
    blockCaches.clear();
    for (const block of state.blocks) {
      blockCaches.set(block.id, createBlockCache(block.variables));
    }
  }

  function blockCache(block) {
    let cache = blockCaches.get(block.id);
    if (!cache) {
      cache = createBlockCache(block.variables);
      blockCaches.set(block.id, cache);
    }
    return cache;
  }

  function createBlockCache(variables) {
    const variableById = new Map();
    let variableCount = 0;
    let firstReadableId;
    let hasExpandableNodes = false;
    const stack = [...variables].reverse();

    while (stack.length > 0) {
      const variable = stack.pop();
      if (!variable) {
        continue;
      }

      variableCount++;
      variableById.set(variable.id, variable);
      if (firstReadableId === undefined && variable.readable) {
        firstReadableId = variable.id;
      }

      const children = variable.children || [];
      if (children.length > 0) {
        hasExpandableNodes = true;
        for (let index = children.length - 1; index >= 0; index--) {
          stack.push(children[index]);
        }
      }
    }

    return { variableById, variableCount, firstReadableId, hasExpandableNodes };
  }

  function currentValues() {
    return state.values[state.activeDbId] || {};
  }

  function writeKind(variable) {
    const type = normalizeValueType(variable.type);
    if (!variable.readable) {
      return 'unsupported';
    }
    if (type === 'bool') {
      return 'bool';
    }
    if (['byte', 'usint', 'sint', 'word', 'uint', 'int', 'dword', 'udint', 'dint', 'lword', 'ulint', 'lint'].includes(type)) {
      return 'integer';
    }
    if (type === 'real' || type === 'lreal') {
      return 'float';
    }
    if (['date', 'time', 'tod', 'time_of_day', 'timeofday', 'ltod', 'ltime_of_day', 'ltimeofday', 'dt', 'date_and_time', 'dateandtime', 'ldt', 'dtl'].includes(type)) {
      return 'datetime';
    }
    if (type === 'char' || type === 'wchar' || type.startsWith('string[') || type.startsWith('wstring[')) {
      return 'text';
    }
    return 'unsupported';
  }

  function normalizeValueType(type) {
    return type.trim().replace(/\s+/g, '').toLowerCase();
  }

  function formatOperationValue(variable) {
    const value = currentValues()[variable.id];
    if (value === undefined || value === null) {
      return '-';
    }
    if (writeKind(variable) === 'integer' && (typeof value === 'number' || typeof value === 'string')) {
      return formatIntegerValue(value, state.writeRadix);
    }
    return formatValue(variable);
  }

  function defaultWriteValue(variable, kind) {
    const value = currentValues()[variable.id];
    if (kind === 'integer' && (typeof value === 'number' || typeof value === 'string')) {
      return formatIntegerValue(value, state.writeRadix);
    }
    if (kind === 'float' && typeof value === 'number') {
      return String(value);
    }
    if (kind === 'text' && typeof value === 'string' && ['char', 'wchar'].includes(normalizeValueType(variable.type)) && isEmptyCharValue(value)) {
      return '';
    }
    if ((kind === 'datetime' || kind === 'text') && typeof value === 'string') {
      return value;
    }
    return '';
  }

  function writePlaceholder(variable, kind) {
    if (kind === 'integer') {
      return '0';
    }
    if (kind === 'float') {
      return '0.0';
    }

    const type = normalizeValueType(variable.type);
    if (type === 'date') {
      return '1990-01-01';
    }
    if (type === 'time') {
      return 'T#0d_00:00:00.000';
    }
    if (type === 'tod' || type === 'time_of_day' || type === 'timeofday') {
      return '00:00:00.000';
    }
    if (type === 'ltod' || type === 'ltime_of_day' || type === 'ltimeofday') {
      return '00:00:00.000000000';
    }
    if (type === 'dt' || type === 'date_and_time' || type === 'dateandtime' || type === 'ldt' || type === 'dtl') {
      return '1990-01-01T00:00:00.000Z';
    }
    return 'text';
  }

  function validateWriteValue(variable, kind, value) {
    if (kind === 'integer') {
      return validateIntegerWrite(variable, value);
    }
    if (kind === 'float') {
      return Number.isFinite(Number(value.trim())) ? undefined : 'Enter a valid numeric value.';
    }
    if (kind === 'datetime') {
      return validateDateTimeWrite(variable, value);
    }
    if (kind === 'text') {
      return validateTextWrite(variable, value);
    }
    return undefined;
  }

  function validateIntegerWrite(variable, value) {
    const range = integerRange(variable.type);
    if (!range) {
      return undefined;
    }

    const parsed = parseIntegerInput(value, state.writeRadix);
    if (parsed === undefined) {
      return 'Enter a valid integer value.';
    }
    if (parsed < range.min || parsed > range.max) {
      return `${variable.type} value must be between ${range.min} and ${range.max}.`;
    }
    return undefined;
  }

  function integerRange(type) {
    const ranges = {
      byte: [0n, 0xffn],
      usint: [0n, 0xffn],
      sint: [-0x80n, 0x7fn],
      word: [0n, 0xffffn],
      uint: [0n, 0xffffn],
      int: [-0x8000n, 0x7fffn],
      dword: [0n, 0xffffffffn],
      udint: [0n, 0xffffffffn],
      dint: [-0x80000000n, 0x7fffffffn],
      lword: [0n, 0xffffffffffffffffn],
      ulint: [0n, 0xffffffffffffffffn],
      lint: [-0x8000000000000000n, 0x7fffffffffffffffn]
    };
    const range = ranges[normalizeValueType(type)];
    return range ? { min: range[0], max: range[1] } : undefined;
  }

  function parseIntegerInput(value, radix) {
    const normalizedRadix = [2, 8, 10, 16].includes(radix) ? radix : 10;
    const text = value.trim().replace(/_/g, '');
    const sign = text.startsWith('-') ? -1n : 1n;
    const unsigned = text.replace(/^[+-]/, '').replace(/^0x/i, '').replace(/^16#/i, '').replace(/^2#/i, '').replace(/^8#/i, '');
    if (!unsigned || !isIntegerDigits(unsigned, normalizedRadix)) {
      return undefined;
    }
    try {
      return sign * parseUnsignedBigInt(unsigned, normalizedRadix);
    } catch {
      return undefined;
    }
  }

  function parseUnsignedBigInt(text, radix) {
    if (radix === 16) {
      return BigInt(`0x${text}`);
    }
    if (radix === 8) {
      return BigInt(`0o${text}`);
    }
    if (radix === 2) {
      return BigInt(`0b${text}`);
    }
    return BigInt(text);
  }

  function isIntegerDigits(text, radix) {
    if (radix === 2) {
      return /^[01]+$/i.test(text);
    }
    if (radix === 8) {
      return /^[0-7]+$/i.test(text);
    }
    if (radix === 16) {
      return /^[0-9a-f]+$/i.test(text);
    }
    return /^\d+$/i.test(text);
  }

  function validateDateTimeWrite(variable, value) {
    const type = normalizeValueType(variable.type);
    const text = value.trim();
    if (type === 'date') {
      return isValidDateText(text.replace(/^(date|d)#/i, '')) ? undefined : 'Enter a Date value as YYYY-MM-DD.';
    }
    if (type === 'time') {
      return isValidTimeDuration(text) ? undefined : 'Enter a Time value like T#0d_01:02:03.004.';
    }
    if (type === 'tod' || type === 'time_of_day' || type === 'timeofday') {
      return isValidTimeOfDay(text, 3) ? undefined : 'Enter a TOD value as HH:mm:ss.mmm.';
    }
    if (type === 'ltod' || type === 'ltime_of_day' || type === 'ltimeofday') {
      return isValidTimeOfDay(text, 9) ? undefined : 'Enter an LTOD value as HH:mm:ss.nnnnnnnnn.';
    }
    if (type === 'dt' || type === 'date_and_time' || type === 'dateandtime' || type === 'ldt' || type === 'dtl') {
      return isValidDateTimeText(text) ? undefined : 'Enter a date-time value like 1990-01-01T00:00:00.000Z.';
    }
    return undefined;
  }

  function isValidDateText(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) {
      return false;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function isValidTimeDuration(text) {
    const colon = /^([+-])?(?:time#|t#)?(?:(\d+)d_?)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/i.exec(text);
    if (colon) {
      return Number(colon[3]) <= 23 && Number(colon[4]) <= 59 && Number(colon[5]) <= 59;
    }

    const source = text.trim().replace(/^(time|t)#/i, '').replace(/^[+-]/, '');
    const tokenRegexp = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/gi;
    let consumed = '';
    let match;
    while ((match = tokenRegexp.exec(source)) !== null) {
      consumed += match[0];
    }
    return Boolean(consumed) && consumed.length === source.replace(/_/g, '').length;
  }

  function isValidTimeOfDay(value, fractionDigits) {
    const text = value.trim().replace(/^(tod|time_of_day|timeofday|ltod|ltime_of_day|ltimeofday)#/i, '');
    const match = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(text);
    if (!match) {
      return false;
    }

    const fraction = match[4] || '';
    return Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3]) <= 59 && fraction.length <= fractionDigits;
  }

  function isValidDateTimeText(value) {
    const text = value.trim().replace(/^(date_and_time|dt|ldt|dtl)#/i, '');
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? `${text}T00:00:00.000Z`
      : /(?:z|[+-]\d{2}:?\d{2})$/i.test(text)
        ? text
        : `${text}Z`;
    return !Number.isNaN(new Date(normalized).getTime());
  }

  function validateTextWrite(variable, value) {
    const type = normalizeValueType(variable.type);
    const text = unquoteWriteText(value);
    if (type === 'char' || type === 'wchar') {
      return text.length <= 1 ? undefined : `${variable.type} value must be zero or one character.`;
    }

    const declaredLength = stringDeclaredLength(type);
    if (declaredLength === undefined) {
      return undefined;
    }
    if (text.length > declaredLength) {
      return `${variable.type} value must be ${declaredLength} characters or fewer.`;
    }
    if (type.startsWith('string[') && !isLatin1Text(text)) {
      return 'String values only support single-byte characters.';
    }
    return undefined;
  }

  function unquoteWriteText(value) {
    const text = value.trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
    return quoted ? quoted[2] : value;
  }

  function stringDeclaredLength(type) {
    const match = /\[(\d+)\]$/i.exec(type);
    return match ? Number(match[1]) : undefined;
  }

  function isLatin1Text(text) {
    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) > 0xff) {
        return false;
      }
    }
    return true;
  }

  function validatePulseMs(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0 || number > 600000) {
      return 'Pulse time must be between 0 and 600000 ms.';
    }
    return undefined;
  }

  function formatIntegerValue(value, radix) {
    if (radix === 10) {
      return String(value);
    }
    const integer = parseDisplayInteger(value);
    if (integer === undefined) {
      return String(value);
    }
    const prefix = radix === 16 ? '16#' : radix === 2 ? '2#' : '8#';
    const sign = integer < 0n ? '-' : '';
    const abs = integer < 0n ? -integer : integer;
    return `${sign}${prefix}${abs.toString(radix).toUpperCase()}`;
  }

  function parseDisplayInteger(value) {
    try {
      if (typeof value === 'number') {
        return Number.isInteger(value) ? BigInt(value) : undefined;
      }
      if (/^[+-]?\d+$/.test(value.trim())) {
        return BigInt(value.trim());
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  function isExpanded(id) {
    if (state.expanded[id] === undefined) {
      state.expanded[id] = true;
    }
    return state.expanded[id];
  }

  function formatAddress(variable) {
    if (variable.offset.bit !== undefined) {
      return `${variable.offset.byte}.${variable.offset.bit}`;
    }
    return `${variable.offset.byte}.0`;
  }

  function formatValue(variable) {
    const value = currentValues()[variable.id];
    if (value === undefined || value === null) {
      return variable.readable ? '-' : '';
    }
    const textValue = formatTextValue(variable, value);
    if (textValue !== undefined) {
      return textValue;
    }
    return String(value);
  }

  function formatTextValue(variable, value) {
    if (typeof value !== 'string') {
      return undefined;
    }
    const type = normalizeTextType(variable.type);
    if (type === 'char' || type === 'wchar') {
      return isEmptyCharValue(value) ? "''" : `'${value}'`;
    }
    if (type.startsWith('string[') || type.startsWith('wstring[')) {
      return value === '' ? "''" : undefined;
    }
    return undefined;
  }

  function isEmptyCharValue(value) {
    if (value === '') {
      return true;
    }

    return value.length === 1 && (value.charCodeAt(0) <= 0x1f || value.charCodeAt(0) === 0x7f);
  }

  function normalizeTextType(type) {
    return type.trim().replace(/\s+/g, '').toLowerCase();
  }

  function renderStatus(updatedAt) {
    els.statusState.className = `state-${state.status.state}`;
    els.statusState.textContent = statusLabel(state.status.state);
    els.statusMessage.textContent = statusMessage(updatedAt);
    const readableBlocks = state.blocks.filter((block) => block.number !== undefined).length;
    const continuous = state.continuousBlockId ? ` | continuous: ${continuousBlockName()}` : '';
    els.statusStats.textContent = `DB: ${state.blocks.length} | readable: ${readableBlocks}${continuous}`;
  }

  function statusLabel(value) {
    if (value === 'connected') {
      return 'Connected';
    }
    if (value === 'connecting') {
      return 'Connecting';
    }
    if (value === 'error') {
      return 'Error';
    }
    return 'Disconnected';
  }

  function statusMessage(updatedAt) {
    const parts = [state.status.message || ''];
    const active = activeBlock();
    if (active) {
      const dbNumber = active.number === undefined ? 'DB number not set' : `DB${active.number}`;
      parts.push(`${active.name}: ${dbNumber}, ${active.readSize} bytes`);
      if (active.diagnostics && active.diagnostics.length > 0) {
        parts.push(`diagnostics ${active.diagnostics.length}`);
      }
    }
    if (updatedAt || state.status.updatedAt) {
      parts.push(new Date(updatedAt || state.status.updatedAt).toLocaleTimeString());
    }
    return parts.filter(Boolean).join(' | ');
  }

  function continuousBlockName() {
    const block = state.blocks.find((item) => item.id === state.continuousBlockId);
    return block ? block.name : '-';
  }
})();
