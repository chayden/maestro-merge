// Content script for the SwimTopia Meet Entries by Event report.

(function () {
  if (window.__swimtopiaReportHelperLoaded) return;
  window.__swimtopiaReportHelperLoaded = true;
  let timesCleared = false;

  function isMeetEntriesByEventReport() {
    const { href, pathname } = window.location;
    return pathname.includes('/meet_entries_report') || href.includes('meet_entries_report');
  }

  function clearTimesFromMeetEntriesByEvent() {
    const timeText = /^\s*(?:(?:\d+:)?\d{1,2}\.\d{2})(?:[SYML])?\s*$/i;
    const relayBlocks = new Set();
    let clearedRelays = 0;

    document.querySelectorAll('tr.relay_team').forEach(row => {
      relayBlocks.add(row.closest('.no-page-break'));

      const splitCell = row.querySelectorAll('td')[2];
      if (splitCell && timeText.test(splitCell.textContent)) {
        splitCell.textContent = '';
        clearedRelays += 1;
      }
    });

    relayBlocks.forEach(block => {
      if (!block) return;
      block.querySelectorAll(':scope > span').forEach(span => {
        if (timeText.test(span.textContent)) span.textContent = '';
      });
    });

    document.querySelectorAll('table.stylized tr').forEach(row => {
      [6, 5, 4, 3].forEach(index => row.children[index]?.remove());
      const spacer = row.insertCell?.(-1) || document.createElement('th');
      spacer.innerHTML = '&nbsp;';
      spacer.style.width = '60%';
      spacer.style.border = '0';
      spacer.style.background = 'transparent';
      if (!spacer.parentNode) row.appendChild(spacer);
    });

    return `Cleared ${clearedRelays} relay split(s) and ${relayBlocks.size} relay seed time(s), then removed Time/Date/Meet columns.`;
  }

  function showClearedButtonState(button) {
    if (!button) return;
    button.disabled = true;
    button.textContent = 'Times Cleared';
    setTimeout(() => {
      button.disabled = false;
      button.textContent = 'Clear Times';
    }, 2000);
  }

  function runClearTimes() {
    if (!isMeetEntriesByEventReport()) {
      return { ok: false, error: 'Clear Times is only available on Meet Entries by Event reports.' };
    }
    const button = document.getElementById('st-clear-times-button');
    if (timesCleared) {
      showClearedButtonState(button);
      return { ok: true };
    }

    try {
      clearTimesFromMeetEntriesByEvent();
      timesCleared = true;
      showClearedButtonState(button);
      return { ok: true };
    } catch (err) {
      if (button) {
        button.disabled = false;
        button.textContent = 'Clear Times';
      }
      return { ok: false, error: err.message };
    }
  }

  function createClearTimesButton() {
    if (!isMeetEntriesByEventReport() || document.getElementById('st-clear-times-button')) return;

    const button = document.createElement('button');
    button.id = 'st-clear-times-button';
    button.className = 'st-clear-times-button';
    button.type = 'button';
    button.title = 'Clear times from this report';
    button.textContent = 'Clear Times';
    button.addEventListener('click', runClearTimes);
    document.body.appendChild(button);
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'RUN_SWIMTOPIA_ACTION') respond(runClearTimes());
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createClearTimesButton);
  } else {
    setTimeout(createClearTimesButton, 100);
  }
})();
