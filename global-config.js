'use strict';

(() => {
  const TABLE = 'event_settings';
  let loading = false;
  let saveChain = Promise.resolve();

  const localPersist = persist;

  function sharedPayload() {
    return {
      version: 2,
      subjects: Array.isArray(cfg.subjects) ? cfg.subjects : [],
      categories: Array.isArray(cfg.categories) ? cfg.categories : [],
      accounts: Array.isArray(cfg.accounts) ? cfg.accounts : []
    };
  }

  function setStatus(text, ok = true) {
    const status = document.getElementById('sharedConfigStatus');
    if (status) {
      status.textContent = text;
      status.className = ok ? 'ok' : 'warning';
    }
    $('onlineBadge').textContent = text;
  }

  async function compressImageToDataUrl(file) {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });
    const scale = Math.min(1, 900 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(objectUrl);
    return canvas.toDataURL('image/jpeg', 0.78);
  }

  fileToDataUrl = compressImageToDataUrl;

  async function saveSharedSettings() {
    if (!cloud) throw new Error('Серверная библиотека не загрузилась');
    if (!navigator.onLine) throw new Error('Нет интернета');

    setStatus('сохраняю общие настройки…');
    const {error} = await cloud.from(TABLE).upsert({
      event_id: EVENT_ID,
      config: sharedPayload(),
      updated_at: new Date().toISOString()
    }, {onConflict: 'event_id'});

    if (error) throw error;
    setStatus('онлайн · настройки сохранены для всех');
    return true;
  }

  function queueSave() {
    saveChain = saveChain
      .catch(() => {})
      .then(() => saveSharedSettings())
      .catch((error) => {
        console.error('Shared settings save failed', error);
        setStatus(`ошибка сохранения: ${error.message || error}`, false);
        toast(`Не сохранилось на сервере: ${error.message || error}`);
      });
    return saveChain;
  }

  persist = function patchedPersist(options = {}) {
    localPersist();
    if (options.shared !== false && options.global !== false) queueSave();
  };

  async function loadSharedSettings() {
    if (loading) return false;
    if (!cloud) throw new Error('Серверная библиотека не загрузилась');
    if (!navigator.onLine) throw new Error('Нет интернета');

    loading = true;
    setStatus('загружаю общие настройки…');
    try {
      const {data, error} = await cloud
        .from(TABLE)
        .select('config,updated_at')
        .eq('event_id', EVENT_ID)
        .maybeSingle();

      if (error) throw error;

      if (!data?.config) {
        setStatus('общих настроек пока нет');
        return false;
      }

      const remote = data.config;
      cfg = {
        ...cfg,
        cashier: cfg.cashier,
        subjects: Array.isArray(remote.subjects) ? remote.subjects : cfg.subjects,
        categories: Array.isArray(remote.categories) ? remote.categories : cfg.categories,
        accounts: Array.isArray(remote.accounts) ? remote.accounts : cfg.accounts
      };

      localPersist();
      setStatus('онлайн · настройки загружены с сервера');
      return true;
    } finally {
      loading = false;
    }
  }

  const settingsView = document.getElementById('settingsView');
  if (settingsView && !document.getElementById('sharedConfigStatus')) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h3>Общие настройки мероприятия</h3>
      <div id="sharedConfigStatus" class="muted">проверка сервера…</div>
      <p class="muted">Авторы, категории, счета и QR общие для всех телефонов. Имя кассира хранится отдельно на каждом устройстве.</p>
      <div class="row">
        <button id="pullSharedConfig" type="button">Загрузить с сервера</button>
        <button id="pushSharedConfig" type="button">Сохранить на сервер</button>
      </div>`;
    settingsView.insertBefore(card, settingsView.children[1] || null);

    document.getElementById('pullSharedConfig').addEventListener('click', async () => {
      try {
        await loadSharedSettings();
        toast('Общие настройки загружены');
      } catch (error) {
        setStatus(`ошибка загрузки: ${error.message || error}`, false);
        toast(`Не удалось загрузить: ${error.message || error}`);
      }
    });

    document.getElementById('pushSharedConfig').addEventListener('click', async () => {
      try {
        await saveSharedSettings();
        toast('Общие настройки сохранены для всех');
      } catch (error) {
        setStatus(`ошибка сохранения: ${error.message || error}`, false);
        toast(`Не удалось сохранить: ${error.message || error}`);
      }
    });
  }

  const saveCashierButton = document.getElementById('saveCashier');
  if (saveCashierButton) {
    saveCashierButton.addEventListener('click', () => {
      setTimeout(() => localPersist(), 0);
    }, true);
  }

  const changeTargets = ['addSubject', 'addCategory', 'addAccount'];
  changeTargets.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.addEventListener('click', () => {
      setTimeout(() => queueSave(), id === 'addAccount' ? 1200 : 100);
    });
  });

  settingsView?.addEventListener('click', (event) => {
    if (event.target.closest('[data-toggle-subject],[data-delete-subject],[data-toggle-category],[data-delete-category],[data-toggle-account],[data-delete-account]')) {
      setTimeout(() => queueSave(), 100);
    }
  });

  settingsView?.addEventListener('change', (event) => {
    if (event.target.closest('[data-replace-qr]')) {
      setTimeout(() => queueSave(), 1200);
    }
  });

  window.addEventListener('online', () => loadSharedSettings().catch(console.error));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine) loadSharedSettings().catch(console.error);
  });

  window.POTLACH_SHARED_CONFIG = {
    refresh: loadSharedSettings,
    save: saveSharedSettings
  };

  loadSharedSettings().catch((error) => {
    console.error('Shared settings load failed', error);
    setStatus(`ошибка загрузки: ${error.message || error}`, false);
  });
})();