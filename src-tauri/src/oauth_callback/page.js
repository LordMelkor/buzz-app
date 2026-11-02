function closeWindow() {
  document.body.dataset.closing = "false";
  window.close();
}

if (document.body.dataset.complete === "true") {
  document.body.dataset.closing = "true";
  setTimeout(closeWindow, Number(document.body.dataset.closeDelay) * 1000);
}
