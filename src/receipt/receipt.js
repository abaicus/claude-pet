'use strict';
// The receipt window is a printer and nothing else: it asks the brain for
// today's lines and puts them on the paper. Every figure on it was computed
// brain-side (src/brain/receipt.js), which is also where it is tested.

/* global petAPI */

const $ = (id) => document.getElementById(id);
let text = '';

async function print() {
  const lines = await petAPI.getReceipt();
  text = (lines || []).join('\n');
  $('roll').textContent = text;
}

// Live, because a receipt you left open while working should keep up. The
// brain recomputes on demand, so this is just a re-ask on a slow timer.
print();
setInterval(print, 5000);

$('copy').addEventListener('click', () => {
  petAPI.copyReceipt(text);
  $('copy').textContent = 'copied ✓';
  setTimeout(() => { $('copy').textContent = 'copy'; }, 1200);
});
$('close').addEventListener('click', () => petAPI.closeReceipt());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') petAPI.closeReceipt();
  // ⌘C with nothing selected should still do the obvious thing here.
  if ((e.metaKey || e.ctrlKey) && e.key === 'c' && !String(getSelection())) petAPI.copyReceipt(text);
});
