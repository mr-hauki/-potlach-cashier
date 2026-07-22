'use strict';

(() => {
  const TABLE = 'event_settings';
  let saveTimer = null;
  let loading = false;

  const localPersist = persist;

  function sharedPayload() {
    return {
      version: 1,
      subjects: cfg.subjects,
      categories: cfg.categories,
      accounts: cfg.accounts
    };
  }

  function hasCustomSettings() {
    return cfg.accounts.length > 0
      || cfg.subjects.some((item) => !['subject-unknown', 'subject-bar'].includes(item.id))
      || JSON.stringify(cfg.categories) !== JSON.stringify(defaults.categories);
  }

  function setSharedStatus(text, ok = true) {
    $('onlineBadge').textContent = text;
    const status = document.getElementById('sharedConfigStatus');
    if (status) {
      status.textContent = text;
      status.className = ok ? 'ok' : 'warning';
    }
  }

  async function saveSharedSettings() {
    if (!cloud || !navigator.onLine) return false;
    const {error} = await cloud.from(TABLE).upsert({
      event_id: EVENT_ID,
      config: sharedPayload(),
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
    setSharedStatus('онлайн · настройки общие');
    return true;
  }

  function scheduleSharedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await saveSharedSettings();
      } catch (error) {
        console.error(error);
        setSharedStatus('настройки только на этом телефоне', false);
        toast('Настройки сохранены локально, но не отправлены на сервер');
      }
    }, 350);
  }

  persist = function patchedPersist(options = {}) {
    localPersist();
    if (options.global !== false) scheduleSharedSave();
  };

  async function loadSharedSettings() {
    if (loading || !cloud || !navigator.onLine) return false;
    loading = true;
    try {
      const {data, error} = await cloud
        .from(TABLE)
        .select('config,updated_at')
        .eq('event_id', EVENT_ID)
        .maybeSingle();

      if (error) {
        console.error(error);
        setSharedStatus('общие настройки не подключены', false);
        return false;
      }

      if (data?.config) {
        const remote = data.config;
        cfg = {
          ...cfg,
          cashier: cfg.cashier,
          subjects: Array.isArray(remote.subjects) ? remote.subjects : cfg.subjects,
          categories: Array.isArray(remote.categories) ? remote.categories : cfg.categories,
          accounts: Array.isArray(remote.accounts) ? remote.accounts : cfg.accounts
        };
        localPersist();
        setSharedStatus('онлайн · настройки общие');
        return true;
      }

      if (hasCustomSettings()) {
        await saveSharedSettings();
        setSharedStatus('онлайн · настройки опубликованы');
        return true;
      }

      setSharedStatus('онлайн · общих настроек пока нет');
      return false;
    } finally {
      loading = false;
    }
  }

  const settingsView = document.getElementById('settingsView');
  if (settingsView && !document.getElementById('sharedConfigStatus')) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<h3>Общие настройки мероприятия</h3><div id="sharedConfigStatus" class="muted">проверка сервера…</div><p class="muted">Авторы, категории и QR общие для всех телефонов. Имя кассира хранится только на этом устройстве.</p><button id="refreshSharedConfig" type="button" style="width:100%">Обновить общие настройки</button>';
    settingsView.insertBefore(card, settingsView.children[1] || null);
    document.getElementById('refreshSharedConfig').addEventListener('click', async () => {
      await loadSharedSettings();
      toast('Общие настройки обновлены');
    });
  }

  window.addEventListener('online', loadSharedSettings);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadSharedSettings();
  });

  window.POTLACH_SHARED_CONFIG = {
    refresh: loadSharedSettings,
    save: saveSharedSettings
  };

  loadSharedSettings();
})();
