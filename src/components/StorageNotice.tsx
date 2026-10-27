import { ResetControl } from './ResetControl';
import { useAppState } from '../state/StoreContext';
import type { LoadIssue } from '../state/store';

function loadIssueSentence(issue: LoadIssue): string {
  switch (issue) {
    case 'unreadable':
      return 'Stored demo data could not be read, so it has been left unchanged.';
    case 'wrongVersion':
      return 'Stored demo data uses an unsupported version, so it has been left unchanged.';
    default: {
      const unreachable: never = issue;
      return unreachable;
    }
  }
}

/** Shows the load-issue alert with its own reset control and the non-blocking storage warning, or nothing. */
export function StorageNotice() {
  const { loadIssue, storageWarning } = useAppState();

  if (loadIssue === null && !storageWarning) {
    return null;
  }

  // Both can show at once, for example unreadable data followed by a failed save. The alert stays until
  // the store clears `loadIssue` after a save has replaced the stored value; nothing here clears it.
  // A confirmed reset removes the alert with its focused trigger, so focus falls to the page; no focus
  // target is added, because the notice renders nothing once cleared and the next Tab continues from
  // where the alert stood.
  return (
    <>
      {loadIssue !== null && (
        <div role="alert" className="notice notice--alert">
          <p>{`${loadIssueSentence(loadIssue)} Reset to sample data to start again; any new change will also replace it.`}</p>
          <ResetControl label="Reset to sample data" />
        </div>
      )}
      {storageWarning && (
        <p role="status" className="notice notice--status">
          Browser storage is unavailable or full. Changes will not persist after this session.
        </p>
      )}
    </>
  );
}
