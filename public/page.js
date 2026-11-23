// Fills a textarea from a chosen file; wires the print button. No inline scripts (CSP).
document.querySelectorAll('input[data-fill]').forEach((i) => i.addEventListener('change', async () => {
  document.getElementById(i.dataset.fill).value = await i.files[0].text();
}));
document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));
