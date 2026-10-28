import { DEFAULT_PRIORITY } from '../domain/model';
import type { ServiceRequest } from '../domain/model';

/** Returns fresh copies of the three fixed demo requests, in ID order; each call builds new objects. */
export function createSampleRequests(): ServiceRequest[] {
  // Literals are built inside the call so no two callers share a request, history or entry,
  // and timestamps are fixed so every reset yields byte-identical data.
  return [
    {
      id: 'REQ-0001',
      requesterName: 'Alex Example',
      requestType: 'Equipment Request',
      description: 'Requesting a second monitor for the demo desk.',
      priority: DEFAULT_PRIORITY,
      status: 'Draft',
      lastUpdated: '2026-01-05T09:00:00.000Z',
      auditHistory: [
        {
          timestamp: '2026-01-05T09:00:00.000Z',
          role: 'Requester',
          action: 'Created',
          fromStatus: '',
          toStatus: '',
        },
      ],
    },
    {
      id: 'REQ-0002',
      requesterName: 'Jordan Sample',
      requestType: 'Access Request',
      description: 'Read access to the sample project folder for evaluation.',
      priority: DEFAULT_PRIORITY,
      status: 'In Review',
      lastUpdated: '2026-01-07T09:30:00.000Z',
      auditHistory: [
        {
          timestamp: '2026-01-06T10:00:00.000Z',
          role: 'Requester',
          action: 'Created',
          fromStatus: '',
          toStatus: '',
        },
        {
          timestamp: '2026-01-06T10:15:00.000Z',
          role: 'Requester',
          action: 'Submitted',
          fromStatus: 'Draft',
          toStatus: 'Submitted',
        },
        {
          timestamp: '2026-01-07T09:30:00.000Z',
          role: 'Reviewer',
          action: 'Review started',
          fromStatus: 'Submitted',
          toStatus: 'In Review',
        },
      ],
    },
    {
      id: 'REQ-0003',
      requesterName: 'Casey Placeholder',
      requestType: 'General Question',
      description: 'How does this demo store its data?',
      priority: DEFAULT_PRIORITY,
      status: 'Waiting for Information',
      lastUpdated: '2026-01-09T14:30:00.000Z',
      auditHistory: [
        {
          timestamp: '2026-01-08T11:00:00.000Z',
          role: 'Requester',
          action: 'Created',
          fromStatus: '',
          toStatus: '',
        },
        {
          timestamp: '2026-01-08T11:20:00.000Z',
          role: 'Requester',
          action: 'Submitted',
          fromStatus: 'Draft',
          toStatus: 'Submitted',
        },
        {
          timestamp: '2026-01-09T14:00:00.000Z',
          role: 'Reviewer',
          action: 'Review started',
          fromStatus: 'Submitted',
          toStatus: 'In Review',
        },
        {
          timestamp: '2026-01-09T14:30:00.000Z',
          role: 'Reviewer',
          action: 'Information requested',
          fromStatus: 'In Review',
          toStatus: 'Waiting for Information',
          note: 'Please confirm which browser you are using.',
        },
      ],
    },
  ];
}
