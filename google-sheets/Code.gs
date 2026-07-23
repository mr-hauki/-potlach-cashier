/*
 * ПОТЛАЧ — безопасный импорт кассовых операций в Google Sheets.
 *
 * ВАЖНО:
 * - Скрипт выполняет ТОЛЬКО GET-запросы к Supabase.
 * - Он не изменяет и не удаляет операции в базе.
 * - Перед каждым импортом создаётся резервная копия вкладки «02 — ПРОВЕРКА».
 * - Ручные проверки сохраняются по tx_id, а не по номеру строки.
 */

const POTLACH_IMPORT = Object.freeze({
  spreadsheetId: '1qM6oY0ZJbMT33OHCsWXqVKJZbn4XsEppQfMeCcXgRG4',
  supabaseUrl: 'https://dvgsixehiscqemfaddpn.supabase.co',
  supabaseKey: 'sb_publishable_n2Ro5cvbbK0h7P4i6FN4dA_u-zHQCru',
  eventId: 'potlach-24-2026',
  photoBucket: 'transaction-photos',
  rawSheet: '01 — ОПЕРАЦИИ',
  reviewSheet: '02 — ПРОВЕРКА',
  instructionSheet: '00 — ИНСТРУКЦИЯ',
  backupSheet: '98 — BACKUP',
  pageSize: 1000,
  maxRows: 10000,
});

const RAW_HEADERS = [
  'tx_id', 'Время', 'Кассир', 'Тип', 'Категория исходная',
  'Автор исходный', 'Сумма исходная', 'Способ оплаты', 'Счёт',
  'Комментарий кассира', 'Фото', 'Отменена',
  'Состояние синхронизации', 'Загружено в таблицу'
];

const REVIEW_HEADERS = [
  'tx_id', 'Время', 'Кассир', 'Тип', 'Категория исходная',
  'Автор исходный', 'Сумма исходная', 'Оплата', 'Счёт',
  'Комментарий кассира', 'Фото', 'Статус проверки',
  'Исправленная категория', 'Исправленный автор', 'Исправленная сумма',
  'Комментарий проверяющего', 'Проверил', 'Дата проверки',
  'Итоговая категория', 'Итоговый автор', 'Итоговая сумма',
  'Готово к выплате', 'Отменена'
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ПОТЛАЧ')
    .addItem('1. Проверить соединение', 'testPotlachConnection')
    .addItem('2. Обновить операции — только чтение', 'importPotlachTransactions')
    .addToUi();
}

/** Проверяет доступ к Supabase, не меняя ни одной ячейки. */
function testPotlachConnection() {
  try {
    const transactions = fetchAllTransactions_();
    const summary = summarize_(transactions);
    SpreadsheetApp.getUi().alert(
      'Соединение работает',
      'Получено операций: ' + summary.count + '\n' +
      'Неотменённых: ' + summary.activeCount + '\n' +
      'Приход: ' + formatMoney_(summary.income) + '\n' +
      'Расход: ' + formatMoney_(summary.expense) + '\n\n' +
      'База не изменялась.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (error) {
    showError_('Проверка соединения не удалась', error);
    throw error;
  }
}

/**
 * Загружает операции из Supabase в таблицу.
 * Направление данных строго одно: Supabase → Google Sheets.
 */
function importPotlachTransactions() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) {
    throw new Error('Другой импорт уже выполняется. Подожди минуту и повтори.');
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    assertCorrectSpreadsheet_(ss);

    const rawSheet = requireSheet_(ss, POTLACH_IMPORT.rawSheet);
    const reviewSheet = requireSheet_(ss, POTLACH_IMPORT.reviewSheet);
    assertHeaders_(rawSheet, RAW_HEADERS);
    assertHeaders_(reviewSheet, REVIEW_HEADERS);

    // Сначала полностью получаем и проверяем данные. До этого момента таблица не меняется.
    const transactions = fetchAllTransactions_();
    validateTransactions_(transactions);

    const fetchedIds = new Set(transactions.map(function (tx) { return String(tx.id); }));
    assertExistingRowsStillPresent_(rawSheet, fetchedIds, 'сырой выгрузке');
    assertExistingRowsStillPresent_(reviewSheet, fetchedIds, 'проверке');

    // Резервная копия ручной проверки перед любым изменением.
    backupReviewSheet_(ss, reviewSheet);

    const importedAt = new Date();
    writeRawSnapshot_(rawSheet, transactions, importedAt);
    writeReviewSnapshot_(reviewSheet, transactions);

    const summary = summarize_(transactions);
    writeImportStatus_(ss, summary, importedAt);
    SpreadsheetApp.flush();

    ss.toast(
      'Загружено операций: ' + summary.count + '. Supabase не изменялся.',
      'ПОТЛАЧ',
      8
    );

    SpreadsheetApp.getUi().alert(
      'Импорт завершён безопасно',
      'Операций: ' + summary.count + '\n' +
      'Неотменённых: ' + summary.activeCount + '\n' +
      'Приход: ' + formatMoney_(summary.income) + '\n' +
      'Расход: ' + formatMoney_(summary.expense) + '\n\n' +
      'Обновлены только Google Sheets. Supabase и кассовое приложение не изменялись.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (error) {
    showError_('Импорт остановлен без изменения Supabase', error);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function fetchAllTransactions_() {
  const fields = [
    'id', 'event_id', 'created_at', 'updated_at', 'device_id',
    'cashier_name', 'kind', 'category_name', 'subject_name',
    'authorship_status', 'amount', 'payment_method', 'account_name',
    'note', 'photo_path', 'voided'
  ].join(',');

  const all = [];
  let offset = 0;

  while (true) {
    const url = POTLACH_IMPORT.supabaseUrl + '/rest/v1/transactions' +
      '?select=' + encodeURIComponent(fields) +
      '&event_id=eq.' + encodeURIComponent(POTLACH_IMPORT.eventId) +
      '&order=created_at.asc' +
      '&limit=' + POTLACH_IMPORT.pageSize +
      '&offset=' + offset;

    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        apikey: POTLACH_IMPORT.supabaseKey,
        Authorization: 'Bearer ' + POTLACH_IMPORT.supabaseKey,
        Accept: 'application/json'
      },
      muteHttpExceptions: true
    });

    const status = response.getResponseCode();
    const body = response.getContentText();
    if (status < 200 || status >= 300) {
      throw new Error('Supabase вернул HTTP ' + status + ': ' + body.slice(0, 500));
    }

    let page;
    try {
      page = JSON.parse(body);
    } catch (error) {
      throw new Error('Supabase вернул некорректный JSON.');
    }

    if (!Array.isArray(page)) {
      throw new Error('Ожидался список операций, но получен другой ответ.');
    }

    Array.prototype.push.apply(all, page);

    if (page.length < POTLACH_IMPORT.pageSize) break;
    offset += POTLACH_IMPORT.pageSize;

    if (offset >= POTLACH_IMPORT.maxRows) {
      throw new Error('Операций больше защитного лимита ' + POTLACH_IMPORT.maxRows + '. Импорт остановлен.');
    }
  }

  return all;
}

function validateTransactions_(transactions) {
  if (!Array.isArray(transactions)) {
    throw new Error('Выгрузка операций не является массивом.');
  }

  const ids = new Set();
  transactions.forEach(function (tx, index) {
    if (!tx || !tx.id) {
      throw new Error('У операции №' + (index + 1) + ' отсутствует id.');
    }
    const id = String(tx.id);
    if (ids.has(id)) {
      throw new Error('В выгрузке найден повторяющийся tx_id: ' + id);
    }
    ids.add(id);

    const amount = Number(tx.amount);
    if (!Number.isFinite(amount)) {
      throw new Error('Некорректная сумма у операции ' + id);
    }
    if (!tx.created_at || isNaN(new Date(tx.created_at).getTime())) {
      throw new Error('Некорректное время у операции ' + id);
    }
  });
}

function writeRawSnapshot_(sheet, transactions, importedAt) {
  ensureSheetRows_(sheet, transactions.length + 1);

  const oldLastRow = Math.max(sheet.getLastRow(), 2);
  sheet.getRange(2, 1, oldLastRow - 1, RAW_HEADERS.length).clearContent();

  if (!transactions.length) return;

  const rows = transactions.map(function (tx) {
    return [
      String(tx.id),
      new Date(tx.created_at),
      tx.cashier_name || '',
      kindLabel_(tx.kind),
      tx.category_name || '',
      tx.subject_name || '',
      Number(tx.amount),
      tx.payment_method || '',
      tx.account_name || '',
      tx.note || '',
      photoUrl_(tx.photo_path),
      Boolean(tx.voided),
      'на сервере',
      importedAt
    ];
  });

  sheet.getRange(2, 1, rows.length, RAW_HEADERS.length).setValues(rows);
  sheet.getRange(2, 2, rows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  sheet.getRange(2, 7, rows.length, 1).setNumberFormat('#,##0 [$₽-ru-RU]');
  sheet.getRange(2, 14, rows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
}

function writeReviewSnapshot_(sheet, transactions) {
  const existing = readExistingReviews_(sheet);
  const fetchedIds = new Set(transactions.map(function (tx) { return String(tx.id); }));

  existing.ids.forEach(function (id) {
    if (!fetchedIds.has(id)) {
      throw new Error('Операция ' + id + ' есть в проверке, но отсутствует в Supabase. Импорт остановлен.');
    }
  });

  ensureSheetRows_(sheet, transactions.length + 1);

  const oldLastRow = Math.max(sheet.getLastRow(), 2);
  // Не трогаем формульные колонки S:V.
  sheet.getRange(2, 1, oldLastRow - 1, 18).clearContent(); // A:R
  sheet.getRange(2, 23, oldLastRow - 1, 1).clearContent(); // W

  if (!transactions.length) return;

  const reviewRows = [];
  const voidedRows = [];

  transactions.forEach(function (tx) {
    const id = String(tx.id);
    const prior = existing.reviews.get(id) || ['Новая', '', '', '', '', '', '']; // L:R

    reviewRows.push([
      id,
      new Date(tx.created_at),
      tx.cashier_name || '',
      kindLabel_(tx.kind),
      tx.category_name || '',
      tx.subject_name || '',
      Number(tx.amount),
      tx.payment_method || '',
      tx.account_name || '',
      tx.note || '',
      photoUrl_(tx.photo_path),
      prior[0] || 'Новая',
      prior[1] || '',
      prior[2] || '',
      prior[3] === '' || prior[3] === null ? '' : prior[3],
      prior[4] || '',
      prior[5] || '',
      prior[6] || ''
    ]);

    voidedRows.push([Boolean(tx.voided)]);
  });

  sheet.getRange(2, 1, reviewRows.length, 18).setValues(reviewRows);
  sheet.getRange(2, 23, voidedRows.length, 1).setValues(voidedRows);
  sheet.getRange(2, 2, reviewRows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  sheet.getRange(2, 7, reviewRows.length, 1).setNumberFormat('#,##0 [$₽-ru-RU]');
  sheet.getRange(2, 15, reviewRows.length, 1).setNumberFormat('#,##0 [$₽-ru-RU]');
  sheet.getRange(2, 18, reviewRows.length, 1).setNumberFormat('dd.MM.yyyy HH:mm');
}

function readExistingReviews_(sheet) {
  const result = {
    ids: new Set(),
    reviews: new Map()
  };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return result;

  const values = sheet.getRange(2, 1, lastRow - 1, 18).getValues(); // A:R
  values.forEach(function (row) {
    const id = String(row[0] || '').trim();
    if (!id) return;
    if (result.ids.has(id)) {
      throw new Error('Во вкладке проверки повторяется tx_id: ' + id);
    }
    result.ids.add(id);
    result.reviews.set(id, row.slice(11, 18)); // L:R
  });

  return result;
}

function backupReviewSheet_(ss, sourceSheet) {
  let backup = ss.getSheetByName(POTLACH_IMPORT.backupSheet);
  if (!backup) {
    backup = ss.insertSheet(POTLACH_IMPORT.backupSheet);
  }

  const lastRow = Math.max(sourceSheet.getLastRow(), 1);
  const data = sourceSheet.getRange(1, 1, lastRow, REVIEW_HEADERS.length).getValues();

  ensureSheetRows_(backup, data.length + 3);
  ensureSheetColumns_(backup, REVIEW_HEADERS.length);
  backup.clearContents();
  backup.getRange('A1').setValue('Автоматический резерв вкладки «02 — ПРОВЕРКА» перед импортом');
  backup.getRange('A2').setValue(new Date()).setNumberFormat('dd.MM.yyyy HH:mm:ss');
  backup.getRange(4, 1, data.length, REVIEW_HEADERS.length).setValues(data);

  if (!backup.isSheetHidden()) backup.hideSheet();
}

function assertExistingRowsStillPresent_(sheet, fetchedIds, context) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  ids.forEach(function (row) {
    const id = String(row[0] || '').trim();
    if (id && !fetchedIds.has(id)) {
      throw new Error('Операция ' + id + ' есть в ' + context + ', но отсутствует в новой выгрузке. Ничего не изменено.');
    }
  });
}

function assertCorrectSpreadsheet_(ss) {
  if (!ss || ss.getId() !== POTLACH_IMPORT.spreadsheetId) {
    throw new Error('Скрипт запущен не в таблице ПОТЛАЧ.');
  }
}

function assertHeaders_(sheet, expected) {
  const actual = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw new Error(
        'Структура вкладки «' + sheet.getName() + '» изменилась: колонка ' +
        (i + 1) + ' должна называться «' + expected[i] + '», сейчас «' + actual[i] + '». Импорт остановлен.'
      );
    }
  }
}

function requireSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Не найдена вкладка «' + name + '».');
  return sheet;
}

function ensureSheetRows_(sheet, requiredRows) {
  const current = sheet.getMaxRows();
  if (current < requiredRows) {
    sheet.insertRowsAfter(current, requiredRows - current);
  }
}

function ensureSheetColumns_(sheet, requiredColumns) {
  const current = sheet.getMaxColumns();
  if (current < requiredColumns) {
    sheet.insertColumnsAfter(current, requiredColumns - current);
  }
}

function photoUrl_(path) {
  if (!path) return '';
  const value = String(path);
  if (/^https?:\/\//i.test(value)) return value;
  const encodedPath = value.split('/').map(encodeURIComponent).join('/');
  return POTLACH_IMPORT.supabaseUrl + '/storage/v1/object/public/' +
    POTLACH_IMPORT.photoBucket + '/' + encodedPath;
}

function kindLabel_(kind) {
  if (kind === 'income') return 'Приход';
  if (kind === 'expense') return 'Расход';
  return kind || '';
}

function summarize_(transactions) {
  return transactions.reduce(function (summary, tx) {
    summary.count += 1;
    if (!tx.voided) {
      summary.activeCount += 1;
      if (tx.kind === 'income') summary.income += Number(tx.amount) || 0;
      if (tx.kind === 'expense') summary.expense += Number(tx.amount) || 0;
    }
    return summary;
  }, {count: 0, activeCount: 0, income: 0, expense: 0});
}

function writeImportStatus_(ss, summary, importedAt) {
  const sheet = requireSheet_(ss, POTLACH_IMPORT.instructionSheet);
  const values = [
    ['Импорт из Supabase', 'ТОЛЬКО ЧТЕНИЕ'],
    ['Последнее обновление', importedAt],
    ['Операций', summary.count],
    ['Неотменённых', summary.activeCount],
    ['Приход', summary.income],
    ['Расход', summary.expense],
    ['Направление', 'Supabase → Google Sheets']
  ];

  sheet.getRange(22, 1, values.length, 2).setValues(values);
  sheet.getRange('A22:B22').setFontWeight('bold').setBackground('#DDF6E5');
  sheet.getRange('B23').setNumberFormat('dd.MM.yyyy HH:mm:ss');
  sheet.getRange('B26:B27').setNumberFormat('#,##0 [$₽-ru-RU]');
}

function formatMoney_(value) {
  return Utilities.formatString('%,.0f ₽', Number(value) || 0).replace(/,/g, ' ');
}

function showError_(title, error) {
  const message = error && error.message ? error.message : String(error);
  SpreadsheetApp.getUi().alert(
    title,
    message + '\n\nОперации в Supabase не изменялись.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
