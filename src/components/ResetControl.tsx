import { useId, useRef, useState } from 'react';
import { useAppStore } from '../state/StoreContext';

/** Props of `ResetControl`. */
export interface ResetControlProps {
  /** Text of the button that opens the confirmation; defaults to "Reset demo data". */
  label?: string;
}

/** Button that replaces every request with the three samples only after an inline "Confirm reset"; "Cancel" changes nothing. */
export function ResetControl({ label = 'Reset demo data' }: ResetControlProps) {
  const store = useAppStore();
  // State and ids stay local, so the header control and the storage notice's control open independently.
  const [confirming, setConfirming] = useState(false);
  const promptId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Closing removes the focused panel button, so focus returns to the trigger instead of falling to the
  // page body (WCAG 2.4.3). The trigger is still mounted here even when the confirmed reset is about to
  // remove the surrounding notice, because React commits the store update after this handler returns.
  function close() {
    setConfirming(false);
    triggerRef.current?.focus();
  }

  // The store saves the samples once and publishes them; a failed save surfaces as its storage warning.
  function handleConfirm() {
    store.resetToSamples();
    close();
  }

  return (
    <div className="reset-control">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={confirming}
        onClick={() => {
          setConfirming(true);
        }}
      >
        {label}
      </button>
      {confirming && (
        <div className="confirm-panel" role="group" aria-labelledby={promptId}>
          <p id={promptId}>Replace all requests with the three sample requests? This cannot be undone.</p>
          <div className="button-row">
            <button type="button" onClick={handleConfirm}>
              Confirm reset
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
