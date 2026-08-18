import { buildEventTypeCatalogMap, listAllEventTypes } from '../utils/eventTypeCatalog.js'

/** Inline script for Swagger UI: eventType dropdown options follow eventCategory. */
export function buildEventsSwaggerLinkageScript(): string {
  const typesByCategory = buildEventTypeCatalogMap()
  const allEventTypes = listAllEventTypes()
  return `(function installEventsQueryParamLinkage() {
  var typesByCategory = ${JSON.stringify(typesByCategory)};
  var allEventTypes = ${JSON.stringify(allEventTypes)};

  function isListEventsOp(op) {
    if (!op || !op.classList.contains('opblock-get')) return false;
    var pathEl = op.querySelector('.opblock-summary-path');
    if (!pathEl) return false;
    var path = String(pathEl.textContent || '').trim().split(/\\s+/)[0];
    return path === '/events';
  }

  function findQueryParamRow(op, name) {
    return op.querySelector('tr[data-param-in="query"][data-param-name="' + name + '"]');
  }

  function setNativeValue(el, value) {
    if (!el) return;
    var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillSelect(select, options, emptyLabel) {
    var previous = select.value;
    select.innerHTML = '';
    var emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = emptyLabel;
    select.appendChild(emptyOpt);
    options.forEach(function (type) {
      var opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      select.appendChild(opt);
    });
    if (previous && options.indexOf(previous) !== -1) select.value = previous;
    else select.value = '';
  }

  function ensureCustomTypeSelect(typeRow) {
    var cell = typeRow.querySelector('.parameters-col_model');
    if (!cell) return null;
    var custom = cell.querySelector('select[data-cmp-event-type="1"]');
    if (custom) return custom;
    var reactInput = cell.querySelector('input');
    if (!reactInput) return null;
    reactInput.type = 'hidden';
    reactInput.setAttribute('data-cmp-event-type-input', '1');
    var select = document.createElement('select');
    select.className = 'parameter';
    select.setAttribute('data-cmp-event-type', '1');
    select.addEventListener('change', function () {
      setNativeValue(reactInput, select.value);
    });
    cell.appendChild(select);
    return select;
  }

  function refreshEventTypeSelect(op) {
    if (!isListEventsOp(op) || !op.classList.contains('is-open')) return;
    var catRow = findQueryParamRow(op, 'eventCategory');
    var typeRow = findQueryParamRow(op, 'eventType');
    if (!typeRow) return;
    var typeSelect = ensureCustomTypeSelect(typeRow);
    if (!typeSelect) return;
    var catSelect = catRow ? catRow.querySelector('.parameters-col_model select') : null;
    var category = catSelect ? String(catSelect.value || '').trim() : '';
    var types = category && typesByCategory[category] ? typesByCategory[category] : allEventTypes;
    var emptyLabel = category ? '(all in category)' : '(any)';
    fillSelect(typeSelect, types, emptyLabel);
    var reactInput = typeRow.querySelector('input[data-cmp-event-type-input="1"]');
    setNativeValue(reactInput, typeSelect.value);
  }

  function scanSwaggerUi() {
    var blocks = document.querySelectorAll('#swagger-ui .opblock');
    for (var i = 0; i < blocks.length; i++) refreshEventTypeSelect(blocks[i]);
  }

  function onSwaggerChange(event) {
    var target = event.target;
    if (!target || target.tagName !== 'SELECT') return;
    if (target.getAttribute('data-cmp-event-type') === '1') return;
    var row = target.closest('tr[data-param-name]');
    if (!row || row.getAttribute('data-param-name') !== 'eventCategory') return;
    var op = row.closest('.opblock');
    if (!op) return;
    refreshEventTypeSelect(op);
  }

  window.__cmpRefreshEventsSwaggerParams = scanSwaggerUi;
  document.addEventListener('change', onSwaggerChange, true);

  var root = document.getElementById('swagger-ui');
  if (root && typeof MutationObserver !== 'undefined') {
    var timer = null;
    new MutationObserver(function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(scanSwaggerUi, 60);
    }).observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }
})();`
}
