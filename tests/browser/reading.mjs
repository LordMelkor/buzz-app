// Hold real focus outside reading surfaces while a journey establishes unread
// state. Blur the target itself: the sidebar may still be inert while the search
// palette closes, so redirecting focus to a sidebar button is not reliable.
export async function holdReadingFocus(page) {
  await page.addInitScript(() => {
    const hold = ({ target }) => {
      if (
        target instanceof HTMLElement &&
        (target.closest("[data-channel-timeline], [data-reading-surface]") ||
          target.matches(
            '[role="textbox"][aria-label^="Message #"], [role="tab"][data-tab-value^="thread:"]',
          ))
      )
        target.blur();
    };
    document.addEventListener("focusin", hold);
    window.fixtureReleaseReadingFocus = () =>
      document.removeEventListener("focusin", hold);
  });
}

export async function releaseReadingFocus(page) {
  await page.evaluate(() => window.fixtureReleaseReadingFocus());
}

// Observe the real durable result, never seed state or call an engine test hook.
export async function readJournal(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("buzz-read-state-v1", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("partitions", "readonly");
          const read = tx.objectStore("partitions").getAll();
          read.onsuccess = () => resolve(read.result[0]);
          read.onerror = () => reject(read.error);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
