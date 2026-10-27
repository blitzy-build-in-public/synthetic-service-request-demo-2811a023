import { useEffect, useState } from 'react';
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

/** Shows the load-issue alert with its own reset control, and an always-present status region for the storage warning. */
export function StorageNotice() {
  const { loadIssue, storageWarning } = useAppState();
  // Screen readers announce text written into an existing status region, not a region inserted already
  // holding its text (WCAG 4.1.3, technique ARIA22). The region therefore stays rendered while empty,
  // and the warning is written only after the region's first commit, so storage that is unavailable at
  // startup is announced too.
  const [regionMounted, setRegionMounted] = useState(false);
  useEffect(() => {
    setRegionMounted(true);
  }, []);

  // Both can show at once, for example unreadable data followed by a failed save. The alert stays until
  // the store clears `loadIssue` after a save has replaced the stored value; nothing here clears it.
  // A confirmed reset removes the alert with its focused trigger, so focus falls to the page; no focus
  // target is added, because the next Tab continues from where the alert stood and the empty status
  // region left behind is not focusable.
  // The alert hosts the reset control, whose confirmation panel mounts inside it. role="alert" implies
  // aria-atomic="true", under which opening or closing the panel would re-read the whole alert; with
  // atomic off, opening announces only the added prompt, and closing removes nodes, which is not announced.
  // A repeated failed save leaves the warning text as it is, so it is announced once, not on every save.
  return (
    <>
      {loadIssue !== null && (
        <div role="alert" aria-atomic="false" className="notice notice--alert">
          <p>{`${loadIssueSentence(loadIssue)} Reset to sample data to start again; any new change will also replace it.`}</p>
          <ResetControl label="Reset to sample data" />
        </div>
      )}
      <p role="status" className="notice notice--status">
        {regionMounted && storageWarning
          ? 'Browser storage is unavailable or full. Changes will not persist after this session.'
          : null}
      </p>
    </>
  );
}
