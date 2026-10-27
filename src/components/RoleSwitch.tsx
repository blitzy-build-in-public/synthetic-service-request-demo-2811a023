import { useId } from 'react';
import type { ChangeEvent } from 'react';
import { ROLES, isRole } from '../domain/model';
import { useAppState, useAppStore } from '../state/StoreContext';

/** Header select that switches the simulated Requester/Reviewer role; a demo simulation, not authentication. */
export function RoleSwitch() {
  const { role } = useAppState();
  const store = useAppStore();
  const selectId = useId();

  // The option values come from ROLES, but the event only types them as string, so the guard narrows
  // the value instead of a cast.
  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    if (isRole(value)) {
      store.setRole(value);
    }
  }

  return (
    <div className="role-switch">
      <label htmlFor={selectId}>Role (demo simulation, not authentication)</label>
      <select id={selectId} value={role} onChange={handleChange}>
        {ROLES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
