/* DODO Local Config UI — SweetAlert2 wrappers (vendored, same-origin, no CDN).
 * Safety contract:
 *   - ONLY `titleText` and `text` are ever passed to Swal (both render through
 *     textContent), so server/path/client/provider/model strings can never
 *     become markup. The `html` option is never used.
 *   - No secret is ever placed in an alert.
 *   - Motion respects prefers-reduced-motion.
 * If the vendored script failed to load, callers fall back to the <dialog>
 * confirm; browser alert()/confirm() are never the primary UI. */
'use strict';
(() => {
  const DodoUI = (window.DodoUI = window.DodoUI || {});
  const swal = () => window.Sweetalert2 || window.Swal;

  const motion = () =>
    DodoUI.reducedMotion()
      ? { showClass: { popup: '', backdrop: '' }, hideClass: { popup: '', backdrop: '' } }
      : {};

  const base = () => ({ heightAuto: false, buttonsStyling: false, ...motion(),
    customClass: { confirmButton: 'btn primary', cancelButton: 'btn', denyButton: 'btn danger' } });

  DodoUI.alerts = {
    available: () => Boolean(swal()),

    /** Yes/no confirmation. Danger style focuses Cancel and paints Confirm red. */
    async confirm({ title, text, confirmText = 'ยืนยัน', cancelText = 'ยกเลิก', danger = false, icon }) {
      const S = swal();
      if (!S) return null; // caller falls back to the legacy <dialog>
      const result = await S.fire({
        ...base(),
        titleText: title,
        text,
        icon: icon ?? (danger ? 'warning' : 'question'),
        showCancelButton: true,
        confirmButtonText: confirmText,
        cancelButtonText: cancelText,
        focusCancel: danger,
        reverseButtons: true,
        ...(danger ? { customClass: { confirmButton: 'btn danger', cancelButton: 'btn' } } : {}),
      });
      return result.isConfirmed === true;
    },

    /** Confirmation for actions that can cost money or whose outcome is uncertain. */
    async confirmCost({ title, text, confirmText = 'ยืนยันและยอมรับค่าใช้จ่าย' }) {
      return this.confirm({ title, text, confirmText, danger: true, icon: 'warning' });
    },

    /** Short toast for backend-confirmed outcomes. Errors stay until dismissed. */
    toast(kind, text) {
      const S = swal();
      if (!S) return false;
      void S.fire({
        ...base(),
        toast: true,
        position: 'top-end',
        icon: kind === 'success' ? 'success' : kind === 'error' ? 'error' : 'info',
        titleText: text,
        showConfirmButton: false,
        timer: kind === 'error' ? undefined : 4000,
        timerProgressBar: kind !== 'error' && !DodoUI.reducedMotion(),
        showCloseButton: kind === 'error',
      });
      return true;
    },

    /** Blocking error modal for failures the owner must actually read. */
    error({ title, text }) {
      const S = swal();
      if (!S) return false;
      void S.fire({ ...base(), icon: 'error', titleText: title, text, confirmButtonText: 'ปิด' });
      return true;
    },

    /** Modal spinner for an in-flight save/test. Returns a close() function. */
    loading(title, text) {
      const S = swal();
      if (!S) return () => undefined;
      void S.fire({
        ...base(),
        titleText: title,
        text,
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        didOpen: () => S.showLoading(),
      });
      return () => { if (S.isVisible() && S.isLoading()) S.close(); };
    },
  };
})();
