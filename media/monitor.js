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
    statusStats: document.getElementById('statusStats')
  };
  const persisted = vscode.getState() || {};
  state.sidebarWidth = clampSidebarWidth(persisted.sidebarWidth || 280);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      state.blocks = message.blocks || [];
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
      state.status = message.status;
      renderStatus();
      renderDbInfo();
      return;
    }
    if (message.type === 'values') {
      const update = message.update;
      state.values[update.dbId] = update.values;
      if (update.dbId === state.activeDbId) {
        renderVariables();
        renderVariableOps();
      }
      renderStatus(update.updatedAt);
      renderDbInfo();
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

  vscode.postMessage({ type: 'ready' });
  applySidebarLayout();

  function applyOptions() {
    els.host.value = state.options.host;
    els.rack.value = String(state.options.rack);
    els.slot.value = String(state.options.slot);
    els.pollIntervalMs.value = String(state.options.pollIntervalMs);
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
      sidebarWidth: state.sidebarWidth
    });
  }

  function clampSidebarWidth(width) {
    return Math.min(Math.max(Number(width) || 280, 180), 520);
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
    for (const block of state.blocks) {
      const tab = document.createElement('div');
      tab.className = block.id === state.activeDbId ? 'db-list-item active' : 'db-list-item';
      tab.title = block.name;

      const button = document.createElement('button');
      button.className = 'db-list-select';
      button.addEventListener('click', () => {
        state.activeDbId = block.id;
        state.selectedVariableId = undefined;
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

      els.tabs.appendChild(tab);
    }
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
    identity.appendChild(infoItem('Variables', String(countVariables(block.variables))));
    els.dbInfo.appendChild(identity);

    const actions = document.createElement('div');
    actions.className = 'db-actions';
    if (block.number === undefined) {
      const notice = document.createElement('span');
      notice.className = 'db-notice';
      notice.textContent = 'DB number not set';
      notice.title = 'Set the DB block number before reading PLC data.';
      actions.appendChild(notice);
    }

    const hasExpandableNodes = hasExpandableVariables(block.variables);

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

  function hasExpandableVariables(variables) {
    for (const variable of variables) {
      if (variable.children && variable.children.length > 0) {
        return true;
      }
    }
    return false;
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

  function countVariables(variables) {
    let count = 0;
    for (const variable of variables) {
      count++;
      count += countVariables(variable.children || []);
    }
    return count;
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
    for (const variable of block.variables) {
      renderVariableRow(variable, 0);
    }
  }

  function renderVariableRow(variable, level) {
    const tr = document.createElement('tr');
    tr.className = variable.id === state.selectedVariableId ? 'selected' : '';
    tr.title = variable.readable ? 'Select variable' : 'This variable is a container';
    tr.addEventListener('click', () => {
      state.selectedVariableId = variable.id;
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

    const valueCell = textCell(formatValue(variable));
    valueCell.classList.add('value');
    const value = currentValues()[variable.id];
    if (typeof value === 'boolean') {
      valueCell.classList.add(value ? 'boolean-true' : 'boolean-false');
    }
    tr.appendChild(valueCell);
    tr.appendChild(textCell(variable.id));
    els.variables.appendChild(tr);

    if (hasChildren && isExpanded(variable.id)) {
      for (const child of variable.children) {
        renderVariableRow(child, level + 1);
      }
    }
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
    header.appendChild(infoItem('Current', formatOperationValue(variable)));
    els.variableOps.appendChild(header);

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
      const label = document.createElement('label');
      label.className = 'switch operation-switch';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = currentValues()[variable.id] === true;
      input.disabled = !canWrite;
      input.addEventListener('change', () => {
        vscode.postMessage({
          type: 'writeVariable',
          request: {
            dbId: block.id,
            variableId: variable.id,
            value: input.checked
          }
        });
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode('Set Bool'));
      controls.appendChild(label);
    } else if (writable === 'integer' || writable === 'float') {
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
      input.placeholder = writable === 'integer' ? '0' : '0.0';
      valueLabel.appendChild(input);
      controls.appendChild(valueLabel);

      const writeButton = document.createElement('button');
      writeButton.textContent = 'Write';
      writeButton.disabled = !canWrite;
      const write = () => {
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
    if (!block) {
      return undefined;
    }
    return flattenVariables(block.variables).find((variable) => variable.id === state.selectedVariableId);
  }

  function ensureSelectedVariable() {
    const block = activeBlock();
    if (!block) {
      state.selectedVariableId = undefined;
      return;
    }

    const variables = flattenVariables(block.variables);
    if (variables.some((variable) => variable.id === state.selectedVariableId)) {
      return;
    }

    const firstReadable = variables.find((variable) => variable.readable);
    state.selectedVariableId = firstReadable && firstReadable.id;
  }

  function flattenVariables(variables) {
    const result = [];
    for (const variable of variables) {
      result.push(variable);
      result.push(...flattenVariables(variable.children || []));
    }
    return result;
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
    return '';
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
