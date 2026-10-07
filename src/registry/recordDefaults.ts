/**
 * What a new record holds before anyone says anything: the forms open with it, and the Safety Agent knows
 * it as the application's own value — not something a model made up (route Oral, a task due in a week …).
 */
import dayjs from 'dayjs';
import type { RecordKind } from '@/types/records';

export function defaultValues(kind: RecordKind, authorName: string): Record<string, unknown> {
  switch (kind) {
    case 'medication':
      return { route: 'Oral', startDate: dayjs(), refills: 0, status: 'Active', prescribedBy: authorName };
    case 'diagnosis':
      return { status: 'Active', severity: 'Moderate', onsetDate: dayjs(), diagnosedBy: authorName };
    case 'task':
      return { category: 'Follow-up', priority: 'Normal', status: 'Open', assignedTo: authorName, dueDate: dayjs().add(7, 'day') };
    case 'recall':
      return { type: 'Follow-up', priority: 'Normal', status: 'Due' };
    case 'appointment':
      return { type: 'Follow-up', durationMinutes: 30, status: 'Scheduled', priority: 'Routine', locationName: 'Riverside Medical Center', isTelehealth: false };
  }
}
