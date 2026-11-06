
/*
 * Budget App - hardened Supabase client-side controller
 * ----------------------------------------------------
 * Requires:
 * 1) Supabase JS v2 loaded as window.supabase
 * 2) window.APP_CONFIG.supabaseUrl and window.APP_CONFIG.supabaseAnonKey
 * OR window.SUPABASE_URL and window.SUPABASE_ANON_KEY
 * 3) public.app_data(user_id PRIMARY KEY, state JSONB, updated_at TIMESTAMPTZ)
 * 4) RLS policies restricting every row to auth.uid() = user_id
 *
 * This file manages authentication, state loading, validation, dashboard totals,
 * debounced saving, serialized cloud writes, and a safe public state API.
 * It does not create the app's HTML forms or visual expense-management screens.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CATEGORIES = Object.freeze(['مواصلات', 'أكل', 'مستلزمات', 'دروس', 'أخرى']);
  const SAVE_DELAY_MS = 700;
  const MAX_AMOUNT = 1_000_000_000_000;

  const DEFAULT_SUBJECTS = () => [
    { id: 'sub_1', name: 'الفيزياء', estimatedFee: 0, sessionsAttended: 0 },
    { id: 'sub_2', name: 'الكيمياء', estimatedFee: 0, sessionsAttended: 0 },
    { id: 'sub_3', name: 'عربي', estimatedFee: 0, sessionsAttended: 0 },
    { id: 'sub_4', name: 'أحياء', estimatedFee: 0, sessionsAttended: 0 },
    { id: 'sub_5', name: 'إنجليزي', estimatedFee: 0, sessionsAttended: 0 }
  ];

  const DEFAULT_STATE = () => ({
    budget: 0,
    currency: 'ج.م',
    expenses: [],
    subjects: DEFAULT_SUBJECTS(),
    subBudgets: Object.fromEntries(CATEGORIES.map((category) => [category, 0])),
    lessonPayments: [],
    notes: [],
    notificationSettings: { emailEnabled: false }
  });

  let supabaseClient = null;
  let authSubscription = null;
  let currentUser = null;
  let appState = DEFAULT_STATE();

  let saveTimer = null;
  let saveQueue = Promise.resolve();
  let sessionVersion = 0;
  let pendingActivation = null;
  let loadedUserId = null;
  let sessionReady = false;
  let stateRevision = 0;
  let savedRevision = 0;
  let initializationPromise = null;
  let isSigningOut = false;

  // ---------- General helpers ----------

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function safeNumber(value, fallback = 0) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(MAX_AMOUNT, Math.max(0, number));
  }

  function cloneJson(value) {
    // Supabase JSONB data is JSON-compatible. JSON cloning also prevents callers
    // from mutating the internal application state through returned references.
    return JSON.parse(JSON.stringify(value));
  }

  function uid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (_) {
      // Fall through to the compatibility implementation.
    }
    return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
  }

  function today() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function money(value) {
    const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
    return amount.toLocaleString('ar-EG', { maximumFractionDigits: 2 });
  }

  function getErrorMessage(error, fallback = 'حدث خطأ غير متوقع.') {
    if (error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    return fallback;
  }

  function setMessage(id, message, isError = false) {
    const element = $(id);
    if (!element) return;
    element.textContent = String(message ?? '');
    element.className = `text-xs min-h-5 mb-2 ${isError ? 'text-rose-600 font-bold' : 'text-emerald-700'}`;
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
  }

  function setSyncStatus(message, isError = false) {
    const element = $('syncStatus');
    if (!element) return;
    element.textContent = String(message ?? '');
    element.className = isError ? 'text-rose-200 text-xs' : 'text-emerald-100 text-xs';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
  }

  function setButtonBusy(id, busy, busyText) {
    const button = $(id);
    if (!button) return;

    if (busy) {
      if (!button.dataset.originalText) {
        button.dataset.originalText = button.textContent || '';
      }
      button.disabled = true;
      if (busyText) button.textContent = busyText;
    } else {
      button.disabled = false;
      if (button.dataset.originalText !== undefined) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
    }
  }

  function showAuthGate() {
    const gate = $('authGate');
    const shell = $('appShell');
    if (shell) {
      shell.classList.add('hidden');
      shell.classList.remove('flex');
    }
    if (gate) gate.classList.remove('hidden');
  }

  function showAppShell() {
    const gate = $('authGate');
    const shell = $('appShell');
    if (gate) gate.classList.add('hidden');
    if (shell) {
      shell.classList.remove('hidden');
      shell.classList.add('flex');
    }
  }

  // ---------- State validation / normalization ----------

  function normalizeRecords(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter(isPlainObject)
      .map((record) => {
        const normalized = { ...record };
        if (normalized.id === undefined || normalized.id === null || String(normalized.id).trim() === '') {
          normalized.id = uid();
        } else {
          normalized.id = String(normalized.id);
        }
        if (Object.prototype.hasOwnProperty.call(normalized, 'amount')) {
          normalized.amount = safeNumber(normalized.amount);
        }
        return normalized;
      });
  }

  function normalizeSubjects(value, fallback) {
    if (!Array.isArray(value)) return fallback;
    return value
      .filter(isPlainObject)
      .map((subject) => ({
        ...subject,
        id: subject.id ? String(subject.id) : uid(),
        name: typeof subject.name === 'string' ? subject.name.trim().slice(0, 120) : 'مادة بدون اسم',
        estimatedFee: safeNumber(subject.estimatedFee),
        sessionsAttended: Math.floor(safeNumber(subject.sessionsAttended))
      }));
  }

  function normalizeState(input) {
    const base = DEFAULT_STATE();
    if (!isPlainObject(input)) return base;

    const inputBudgets = isPlainObject(input.subBudgets) ? input.subBudgets : {};
    const inputNotifications = isPlainObject(input.notificationSettings)
      ? input.notificationSettings
      : {};

    return {
      budget: safeNumber(input.budget),
      currency: 'ج.م',
      expenses: normalizeRecords(input.expenses),
      subjects: normalizeSubjects(input.subjects, base.subjects),
      subBudgets: Object.fromEntries(
        CATEGORIES.map((category) => [category, safeNumber(inputBudgets[category])])
      ),
      lessonPayments: normalizeRecords(input.lessonPayments),
      notes: Array.isArray(input.notes) ? input.notes : [],
      notificationSettings: {
        emailEnabled: inputNotifications.emailEnabled === true
      }
    };
  }

  function requireReadySession() {
    if (!supabaseClient || !currentUser || !sessionReady || loadedUserId !== currentUser.id) {
      throw new Error('بيانات الحساب لم تُحمّل بعد. تحقق من الاتصال ثم أعد المحاولة.');
    }
  }

  // ---------- Dashboard ----------

  function sumAmounts(records) {
    if (!Array.isArray(records)) return 0;
    return records.reduce((sum, record) => {
      const amount = safeNumber(record && record.amount);
      return Math.min(Number.MAX_SAFE_INTEGER, sum + amount);
    }, 0);
  }

  function updateDashboardUI() {
    const expensesTotal = sumAmounts(appState.expenses);
    const lessonPaymentsTotal = sumAmounts(appState.lessonPayments);
    const spent = expensesTotal + lessonPaymentsTotal;

    const budgetDisplay = $('totalBudgetDisplay');
    const spentDisplay = $('totalSpentDisplay');
    const remainingDisplay = $('remainingDisplay');

    if (budgetDisplay) budgetDisplay.textContent = money(appState.budget);
    if (spentDisplay) spentDisplay.textContent = money(spent);
    if (remainingDisplay) remainingDisplay.textContent = money(appState.budget - spent);
  }

  // ---------- Cloud persistence ----------

  function clearSaveTimer() {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function scheduleSave() {
    if (!currentUser || !sessionReady) return;
    clearSaveTimer();
    setSyncStatus('توجد تغييرات غير محفوظة...');
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      persistNow().catch((error) => {
        console.error('Automatic save failed:', error);
        // persistNow already updates the visible sync status.
      });
    }, SAVE_DELAY_MS);
  }

  function markDirty() {
    requireReadySession();
    stateRevision += 1;
    scheduleSave();
  }

  async function persistNow(options = {}) {
    const force = options.force === true;
    if (!currentUser || !supabaseClient) {
      throw new Error('لا يوجد مستخدم مسجل الدخول لحفظ البيانات.');
    }
    if (!sessionReady || loadedUserId !== currentUser.id) {
      throw new Error('لا يمكن الحفظ قبل اكتمال تحميل بيانات الحساب.');
    }

    clearSaveTimer();
    if (!force && savedRevision >= stateRevision) {
      return { ok: true, skipped: true };
    }

    let snapshot;
    try {
      snapshot = cloneJson(appState);
    } catch (error) {
      setSyncStatus('تعذر تجهيز البيانات للحفظ', true);
      throw new Error(`تعذر تحويل بيانات التطبيق إلى JSON: ${getErrorMessage(error)}`);
    }

    const userId = currentUser.id;
    const capturedSessionVersion = sessionVersion;
    const capturedRevision = stateRevision;
    setSyncStatus('جارٍ الحفظ سحابياً...');

    const writeTask = saveQueue.then(async () => {
      // Prevent a delayed write from an old session from being applied after
      // the user has signed out or another account has become active.
      if (
        capturedSessionVersion !== sessionVersion ||
        !currentUser ||
        currentUser.id !== userId ||
        !sessionReady
      ) {
        throw new Error('تم إلغاء الحفظ لأن جلسة المستخدم تغيرت.');
      }

      const { error } = await supabaseClient
        .from('app_data')
        .upsert(
          {
            user_id: userId,
            state: snapshot,
            updated_at: new Date().toISOString()
          },
          { onConflict: 'user_id' }
        );

      if (error) throw error;

      if (capturedSessionVersion === sessionVersion && currentUser?.id === userId) {
        savedRevision = Math.max(savedRevision, capturedRevision);
        if (savedRevision >= stateRevision) {
          setSyncStatus('تم الحفظ سحابياً');
        } else {
          setSyncStatus('تم حفظ جزء من التغييرات، جارٍ حفظ الأحدث...');
        }
      }

      return { ok: true, revision: capturedRevision };
    });

    // Keep the queue usable after a failed request, while returning the original
    // rejection to the caller so that sign-out can be blocked on a failed save.
    saveQueue = writeTask.catch(() => undefined);

    try {
      return await writeTask;
    } catch (error) {
      if (capturedSessionVersion === sessionVersion && currentUser?.id === userId) {
        setSyncStatus('فشل الحفظ السحابي — بياناتك لم تُؤكَّد سحابياً', true);
      }
      throw error;
    }
  }

  // ---------- Authentication ----------

  function validateCredentials(email, password) {
    const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailLooksValid) {
      throw new Error('يرجى كتابة بريد إلكتروني صالح.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('كلمة المرور يجب ألا تقل عن 8 أحرف.');
    }
  }

  async function authenticate(isSignUp) {
    if (!supabaseClient) {
      setMessage('authMessage', 'خدمة تسجيل الدخول غير مهيأة. تحقق من إعدادات Supabase.', true);
      return;
    }

    const email = $('authEmail')?.value?.trim() || '';
    const password = $('authPassword')?.value || '';

    try {
      validateCredentials(email, password);
    } catch (error) {
      setMessage('authMessage', getErrorMessage(error), true);
      return;
    }

    const buttonId = isSignUp ? 'signUpButton' : 'signInButton';
    setButtonBusy(buttonId, true, 'جارٍ التنفيذ...');
    setMessage('authMessage', 'جارٍ تنفيذ الطلب...');

    try {
      const response = isSignUp
        ? await supabaseClient.auth.signUp({ email, password })
        : await supabaseClient.auth.signInWithPassword({ email, password });

      if (response.error) throw response.error;

      const user = response.data?.user;
      const session = response.data?.session;

      if (isSignUp && !session) {
        setMessage('authMessage', 'تم إنشاء الحساب. راجع بريدك الإلكتروني لتأكيد الحساب، ثم سجّل الدخول.');
        return;
      }

      if (session?.user || user) {
        await activateSession(session?.user || user);
        if (sessionReady) setMessage('authMessage', 'تم تسجيل الدخول بنجاح.');
      } else {
        setMessage('authMessage', 'تم تنفيذ الطلب، لكن لم تُرجع الخدمة جلسة مستخدم.');
      }
    } catch (error) {
      console.error('Authentication error:', error);
      setMessage('authMessage', getErrorMessage(error, 'تعذر إتمام عملية تسجيل الدخول.'), true);
    } finally {
      setButtonBusy(buttonId, false);
    }
  }

  async function sendPasswordReset() {
    if (!supabaseClient) {
      setMessage('authMessage', 'خدمة تسجيل الدخول غير مهيأة.', true);
      return;
    }

    const email = $('authEmail')?.value?.trim() || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setMessage('authMessage', 'اكتب بريدًا إلكترونيًا صالحًا في الحقل بالأعلى أولاً.', true);
      return;
    }

    setButtonBusy('forgotPasswordButton', true, 'جارٍ الإرسال...');
    setMessage('authMessage', 'جارٍ إرسال رابط استعادة كلمة المرور...');

    try {
      const redirectTo =
        window.APP_CONFIG?.passwordResetRedirectTo ||
        `${window.location.origin}/reset-password.html`;

      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;

      // Keep the message generic so the UI does not disclose whether an email
      // address is registered in the system.
      setMessage('authMessage', 'إذا كان البريد مسجلاً، فستصلك تعليمات استعادة كلمة المرور.');
    } catch (error) {
      console.error('Password reset request failed:', error);
      setMessage('authMessage', getErrorMessage(error, 'تعذر إرسال رابط الاستعادة.'), true);
    } finally {
      setButtonBusy('forgotPasswordButton', false);
    }
  }

  async function updatePassword(newPassword) {
    if (!supabaseClient || !currentUser) {
      throw new Error('يجب تسجيل الدخول أولاً.');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new Error('كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف.');
    }

    const { data, error } = await supabaseClient.auth.updateUser({ password: newPassword });
    if (error) throw error;
    return data?.user || null;
  }

  function resetLocalSession() {
    sessionVersion += 1;
    pendingActivation = null;
    currentUser = null;
    loadedUserId = null;
    sessionReady = false;
    appState = DEFAULT_STATE();
    stateRevision = 0;
    savedRevision = 0;
    clearSaveTimer();
    updateDashboardUI();
    showAuthGate();
  }

  async function activateSession(user) {
    if (!user || !user.id) return;

    // Reuse an in-flight activation for the same account. This avoids duplicate
    // loads when both the button handler and Supabase auth event fire.
    if (currentUser?.id === user.id && sessionReady && loadedUserId === user.id) {
      currentUser = user;
      showAppShell();
      return;
    }
    if (pendingActivation?.userId === user.id) {
      currentUser = user;
      return pendingActivation.promise;
    }

    const thisSessionVersion = ++sessionVersion;
    currentUser = user;
    loadedUserId = null;
    sessionReady = false;
    appState = DEFAULT_STATE();
    stateRevision = 0;
    savedRevision = 0;
    clearSaveTimer();
    setSyncStatus('جارٍ تحميل بيانات حسابك...');

    const activationPromise = (async () => {
      try {
        const { data, error } = await supabaseClient
          .from('app_data')
          .select('state')
          .eq('user_id', user.id)
          .maybeSingle();

        if (error) throw error;
        if (thisSessionVersion !== sessionVersion || currentUser?.id !== user.id) return;

        if (data && data.state !== null && data.state !== undefined) {
          appState = normalizeState(data.state);
        } else {
          appState = DEFAULT_STATE();
        }

        loadedUserId = user.id;
        sessionReady = true;
        stateRevision = 0;
        savedRevision = 0;
        updateDashboardUI();
        showAppShell();

        if (!data) {
          // First login: create the initial row. Do not mark the app ready until
          // the first save succeeds, so a missing/blocked row is not silently lost.
          await persistNow({ force: true });
        } else {
          setSyncStatus('متزامن سحابياً');
        }
      } catch (error) {
        console.error('Account data load/initial save failed:', error);
        if (thisSessionVersion !== sessionVersion || currentUser?.id !== user.id) return;
        sessionReady = false;
        loadedUserId = null;
        setSyncStatus('تعذر تحميل البيانات — لم يتم استبدال بياناتك', true);
        showAuthGate();
        setMessage(
          'authMessage',
          `تم التعرف على الحساب، لكن تعذر تحميل بياناته من السحابة. تحقق من الإنترنت وإعدادات قاعدة البيانات ثم أعد تحميل الصفحة. (${getErrorMessage(error)})`,
          true
        );
        throw error;
      } finally {
        if (pendingActivation?.version === thisSessionVersion) {
          pendingActivation = null;
        }
      }
    })();

    pendingActivation = {
      userId: user.id,
      version: thisSessionVersion,
      promise: activationPromise
    };

    return activationPromise;
  }

  async function handleAuthStateChange(event, session) {
    if (session?.user) {
      try {
        await activateSession(session.user);
      } catch (_) {
        // The activation handler already reports the error to the interface.
      }
      return;
    }

    if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
      resetLocalSession();
      if (!isSigningOut) setMessage('authMessage', 'يرجى تسجيل الدخول للمتابعة.');
    }
  }

  async function signOut() {
    if (!supabaseClient) {
      resetLocalSession();
      return;
    }
    if (isSigningOut) return;

    isSigningOut = true;
    setButtonBusy('signOutButton', true, 'جارٍ تسجيل الخروج...');
    clearSaveTimer();

    try {
      // Do not sign out if the latest local edits could not be saved.
      if (currentUser && sessionReady && savedRevision < stateRevision) {
        await persistNow({ force: true });
      }

      const { error } = await supabaseClient.auth.signOut();
      if (error) throw error;

      resetLocalSession();
      setMessage('authMessage', 'تم تسجيل الخروج بنجاح.');
    } catch (error) {
      console.error('Sign-out failed:', error);
      setSyncStatus('تعذر تسجيل الخروج بأمان أو حفظ آخر التعديلات', true);
      // Keep the current session active so the user can retry saving.
    } finally {
      isSigningOut = false;
      setButtonBusy('signOutButton', false);
    }
  }

  // ---------- Public state API ----------

  function updateState(updater, options = {}) {
    requireReadySession();
    if (typeof updater !== 'function') {
      throw new TypeError('updateState يتطلب دالة تعدّل نسخة الحالة.');
    }

    const draft = cloneJson(appState);
    const result = updater(draft);
    if (result && typeof result.then === 'function') {
      throw new TypeError('يجب أن تكون دالة updateState متزامنة وليست async.');
    }

    appState = normalizeState(result === undefined ? draft : result);
    updateDashboardUI();
    if (options.save !== false) markDirty();
    return cloneJson(appState);
  }

  function replaceState(nextState, options = {}) {
    requireReadySession();
    appState = normalizeState(nextState);
    updateDashboardUI();
    if (options.save !== false) markDirty();
    return cloneJson(appState);
  }

  function setBudget(amount) {
    const value = safeNumber(amount, NaN);
    if (!Number.isFinite(value)) throw new Error('قيمة الميزانية غير صحيحة.');
    return updateState((state) => { state.budget = value; });
  }

  function setSubBudget(category, amount) {
    if (!CATEGORIES.includes(category)) throw new Error('فئة الميزانية غير معروفة.');
    const value = safeNumber(amount, NaN);
    if (!Number.isFinite(value)) throw new Error('قيمة الميزانية الفرعية غير صحيحة.');
    return updateState((state) => { state.subBudgets[category] = value; });
  }

  function addExpense(expense) {
    if (!isPlainObject(expense)) throw new TypeError('بيانات المصروف غير صحيحة.');
    const amount = safeNumber(expense.amount, NaN);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('قيمة المصروف يجب أن تكون أكبر من صفر.');

    const record = {
      ...expense,
      id: expense.id ? String(expense.id) : uid(),
      amount,
      category: CATEGORIES.includes(expense.category) ? expense.category : 'أخرى',
      date: typeof expense.date === 'string' && expense.date ? expense.date : today()
    };
    updateState((state) => { state.expenses.push(record); });
    return cloneJson(record);
  }

  function updateRecord(collectionName, id, changes) {
    const allowedCollections = ['expenses', 'lessonPayments', 'subjects'];
    if (!allowedCollections.includes(collectionName)) throw new Error('قائمة البيانات غير مسموح بتعديلها.');
    if (!isPlainObject(changes)) throw new TypeError('التعديلات غير صحيحة.');

    const exists = appState[collectionName].some((record) => String(record.id) === String(id));
    if (!exists) throw new Error('العنصر المطلوب غير موجود.');

    updateState((state) => {
      state[collectionName] = state[collectionName].map((record) => {
        if (String(record.id) !== String(id)) return record;
        const updated = { ...record, ...changes, id: record.id };
        if (Object.prototype.hasOwnProperty.call(updated, 'amount')) {
          const amount = safeNumber(updated.amount, NaN);
          if (!Number.isFinite(amount)) throw new Error('القيمة المالية غير صحيحة.');
          updated.amount = amount;
        }
        if (collectionName === 'subjects') {
          updated.estimatedFee = safeNumber(updated.estimatedFee);
          updated.sessionsAttended = Math.floor(safeNumber(updated.sessionsAttended));
        }
        return updated;
      });
    });
    return true;
  }

  function deleteRecord(collectionName, id) {
    const allowedCollections = ['expenses', 'lessonPayments', 'subjects'];
    if (!allowedCollections.includes(collectionName)) throw new Error('قائمة البيانات غير مسموح بتعديلها.');
    const exists = appState[collectionName].some((record) => String(record.id) === String(id));
    if (!exists) return false;
    updateState((state) => {
      state[collectionName] = state[collectionName].filter((record) => String(record.id) !== String(id));
    });
    return true;
  }

  function addLessonPayment(payment) {
    if (!isPlainObject(payment)) throw new TypeError('بيانات دفعة الدرس غير صحيحة.');
    const amount = safeNumber(payment.amount, NaN);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('قيمة الدفعة يجب أن تكون أكبر من صفر.');
    const record = {
      ...payment,
      id: payment.id ? String(payment.id) : uid(),
      amount,
      date: typeof payment.date === 'string' && payment.date ? payment.date : today()
    };
    updateState((state) => { state.lessonPayments.push(record); });
    return cloneJson(record);
  }

  // ---------- Initialization ----------

  function bindClick(id, handler) {
    const element = $(id);
    if (!element) return;
    // Avoid duplicate listeners if initializeApp is called more than once.
    if (element.dataset.budgetBound === 'true') return;
    element.dataset.budgetBound = 'true';
    element.addEventListener('click', (event) => {
      event.preventDefault();
      Promise.resolve(handler()).catch((error) => {
        console.error(`Handler failed (${id}):`, error);
        if (id.startsWith('sign') || id === 'forgotPasswordButton') {
          setMessage('authMessage', getErrorMessage(error), true);
        }
      });
    });
  }

  async function initializeApp() {
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
      try {
        const url = window.APP_CONFIG?.supabaseUrl || window.SUPABASE_URL || '';
        const key = window.APP_CONFIG?.supabaseAnonKey || window.SUPABASE_ANON_KEY || '';

        if (!url || !key) {
          throw new Error('إعدادات Supabase غير مكتملة: يلزم رابط المشروع ومفتاح anon/publishable.');
        }
        if (!window.supabase || typeof window.supabase.createClient !== 'function') {
          throw new Error('مكتبة Supabase غير محمّلة. تأكد من تحميل supabase-js v2 قبل هذا الملف.');
        }
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
          throw new Error('رابط Supabase غير صالح.');
        }
        if (/service_role|sb_secret_/i.test(key)) {
          throw new Error('ممنوع استخدام service_role أو secret key داخل المتصفح. استخدم anon/publishable key فقط.');
        }

        supabaseClient = window.supabase.createClient(url, key, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
          }
        });

        bindClick('signInButton', () => authenticate(false));
        bindClick('signUpButton', () => authenticate(true));
        bindClick('signOutButton', signOut);
        bindClick('forgotPasswordButton', sendPasswordReset);

        // Keep the callback synchronous; defer async work out of Supabase's
        // auth callback to avoid holding its internal auth lock.
        const listenerResult = supabaseClient.auth.onAuthStateChange((event, session) => {
          Promise.resolve().then(() => handleAuthStateChange(event, session));
        });
        authSubscription = listenerResult?.data?.subscription || null;

        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;

        if (data?.session?.user) {
          await activateSession(data.session.user);
        } else {
          showAuthGate();
          setMessage('authMessage', 'أدخل بريدك الإلكتروني وكلمة المرور للمتابعة.');
        }
      } catch (error) {
        console.error('Application initialization failed:', error);
        setSyncStatus('تعذر تهيئة التطبيق', true);
        setMessage('authMessage', getErrorMessage(error, 'فشل تهيئة التطبيق.'), true);
        showAuthGate();
      }
    })();

    return initializationPromise;
  }

  // Minimal public interface for the rest of the app's UI code.
  // Always modify state through these methods; do not keep external references
  // to the internal appState object.
  window.BudgetApp = Object.freeze({
    categories: CATEGORIES,
    initialize: initializeApp,
    getState: () => cloneJson(appState),
    updateState,
    replaceState,
    setBudget,
    setSubBudget,
    addExpense,
    updateExpense: (id, changes) => updateRecord('expenses', id, changes),
    deleteExpense: (id) => deleteRecord('expenses', id),
    addLessonPayment,
    updateLessonPayment: (id, changes) => updateRecord('lessonPayments', id, changes),
    deleteLessonPayment: (id) => deleteRecord('lessonPayments', id),
    updateSubject: (id, changes) => updateRecord('subjects', id, changes),
    deleteSubject: (id) => deleteRecord('subjects', id),
    save: () => persistNow({ force: true }),
    signOut,
    updatePassword,
    retryLoad: async () => {
      if (!currentUser) throw new Error('لا توجد جلسة مستخدم لإعادة تحميلها.');
      return activateSession(currentUser);
    },
    isReady: () => sessionReady,
    getCurrentUser: () => currentUser ? { id: currentUser.id, email: currentUser.email || '' } : null
  });

  // Best-effort flush when the tab is backgrounded or navigated away from.
  // Browsers may still stop async work during unload, so the debounce interval
  // remains short and every normal save is completed during the active session.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentUser && sessionReady && savedRevision < stateRevision) {
      clearSaveTimer();
      persistNow().catch((error) => console.error('Background save failed:', error));
    }
  });

  window.addEventListener('pagehide', () => {
    if (currentUser && sessionReady && savedRevision < stateRevision) {
      clearSaveTimer();
      persistNow().catch((error) => console.error('Page-exit save failed:', error));
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp, { once: true });
  } else {
    initializeApp();
  }
})();
