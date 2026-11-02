use super::*;
use std::sync::Mutex as StdMutex;

#[derive(Default)]
struct FakeStore {
    key: StdMutex<Option<String>>,
    reads: StdMutex<usize>,
    /// Reads fail, as a locked or refused Keychain does.
    unreadable: StdMutex<bool>,
}
impl KeyStore for Arc<FakeStore> {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        *self.reads.lock().unwrap() += 1;
        if *self.unreadable.lock().unwrap() {
            return Err("locked".into());
        }
        Ok(self.key.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn replace(&self, key: &str) -> Result<(), String> {
        *self.key.lock().unwrap() = Some(key.into());
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        *self.key.lock().unwrap() = None;
        Ok(())
    }
}

fn host(store: &Arc<FakeStore>) -> JevHost {
    JevHost::with(Box::new(store.clone()))
}
fn keyed(key: &str) -> Arc<FakeStore> {
    let store = Arc::new(FakeStore::default());
    *store.key.lock().unwrap() = Some(key.into());
    store
}

#[tokio::test]
async fn set_and_clear_take_effect_without_reading_the_keychain_again() {
    let store = Arc::new(FakeStore::default());
    let host = host(&store);
    assert!(!host.configured().await.unwrap());
    host.set("  tk_new  ").await.unwrap();
    assert!(host.configured().await.unwrap());
    assert_eq!(store.key.lock().unwrap().as_deref(), Some("tk_new"));
    host.clear().await.unwrap();
    assert!(!host.configured().await.unwrap());
    assert_eq!(*store.reads.lock().unwrap(), 1);
}

#[tokio::test]
async fn refuses_a_key_that_is_not_one_printable_token() {
    let store = Arc::new(FakeStore::default());
    let host = host(&store);
    for bad in ["", "a b", "a\nb", "a\u{e9}b", &"x".repeat(513)] {
        assert!(host.set(bad).await.is_err(), "{bad:?}");
    }
    assert!(store.key.lock().unwrap().is_none());
}

#[tokio::test]
async fn an_unreadable_keychain_is_an_error_and_is_read_again() {
    let store = keyed("k");
    *store.unreadable.lock().unwrap() = true;
    let host = host(&store);
    // Not "missing", so the app does not report that no key is saved.
    assert!(host.configured().await.is_err());
    *store.unreadable.lock().unwrap() = false;
    assert!(host.configured().await.unwrap());
    assert_eq!(*store.reads.lock().unwrap(), 2);
}

#[test]
fn clearing_deletes_the_previous_item_first_and_stops_at_a_failure() {
    let mut deleted = Vec::new();
    clear_with(|service| {
        deleted.push(service.to_owned());
        Ok::<_, ()>(())
    })
    .unwrap();
    assert_eq!(deleted, [PREVIOUS_KEY_SERVICE, KEY_SERVICE]);
    deleted.clear();
    assert!(clear_with(|service| {
        deleted.push(service.to_owned());
        Err(())
    })
    .is_err());
    assert_eq!(deleted, [PREVIOUS_KEY_SERVICE]);
}
