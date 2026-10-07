import { useMemo } from 'react';
import dayjs from 'dayjs';
import { useAppSelector } from '@/store';
import { appointmentsSlice, diagnosesSlice, medicationsSlice, recallsSlice, tasksSlice } from '@/store/slices/recordSlices';
import { selectCurrentPatient } from '@/store/slices/patientSlice';
import type { Appointment, Diagnosis, Medication, Recall, Task } from '@/types/domain';

/**
 * Everything the selected patient owns, in one place. Every module page and the
 * dashboard read from here, so a change in one module is visible in all of them
 * on the next render.
 */
export interface PatientOverview {
  patientId: string | null;
  medications: Medication[];
  diagnoses: Diagnosis[];
  tasks: Task[];
  recalls: Recall[];
  appointments: Appointment[];
  counts: { medication: number; diagnosis: number; task: number; recall: number; appointment: number };
  /** The numbers that matter clinically, not just row counts. */
  highlights: {
    activeMedications: number;
    activeDiagnoses: number;
    openTasks: number;
    overdueTasks: number;
    dueRecalls: number;
    upcomingAppointments: number;
    nextAppointment?: Appointment;
  };
  loading: boolean;
}

/** `of`: whose records — a patient's id (the Inbox item's patient); left out: the selected patient's. */
export function usePatientOverview(of?: string | null): PatientOverview {
  const selected = useAppSelector((s) => s.patients.currentPatientId);
  const patientId = of === undefined ? selected : of;
  const allMedications = useAppSelector(medicationsSlice.selectors.selectAll);
  const allDiagnoses = useAppSelector(diagnosesSlice.selectors.selectAll);
  const allTasks = useAppSelector(tasksSlice.selectors.selectAll);
  const allRecalls = useAppSelector(recallsSlice.selectors.selectAll);
  const allAppointments = useAppSelector(appointmentsSlice.selectors.selectAll);
  const loading = useAppSelector(
    (s) => s.medications.status === 'loading' || s.diagnoses.status === 'loading' || s.tasks.status === 'loading' || s.recalls.status === 'loading' || s.appointments.status === 'loading',
  );

  return useMemo(() => {
    const mine = <T extends { patientId: string }>(rows: T[]) => (patientId ? rows.filter((r) => r.patientId === patientId) : []);
    const medications = mine(allMedications);
    const diagnoses = mine(allDiagnoses);
    const tasks = mine(allTasks);
    const recalls = mine(allRecalls);
    const appointments = mine(allAppointments);
    const today = dayjs().startOf('day');
    const upcoming = appointments
      .filter((a) => !dayjs(a.date).isBefore(today) && !['Cancelled', 'No Show', 'Completed'].includes(a.status))
      .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));

    return {
      patientId,
      medications,
      diagnoses,
      tasks,
      recalls,
      appointments,
      counts: {
        medication: medications.length,
        diagnosis: diagnoses.length,
        task: tasks.length,
        recall: recalls.length,
        appointment: appointments.length,
      },
      highlights: {
        activeMedications: medications.filter((m) => m.status === 'Active').length,
        activeDiagnoses: diagnoses.filter((d) => d.status === 'Active' || d.status === 'Chronic').length,
        openTasks: tasks.filter((t) => t.status === 'Open' || t.status === 'In Progress').length,
        overdueTasks: tasks.filter((t) => (t.status === 'Open' || t.status === 'In Progress') && dayjs(t.dueDate).isBefore(today)).length,
        dueRecalls: recalls.filter((r) => r.status === 'Due').length,
        upcomingAppointments: upcoming.length,
        nextAppointment: upcoming[0],
      },
      loading,
    };
  }, [patientId, allMedications, allDiagnoses, allTasks, allRecalls, allAppointments, loading]);
}

/** The patient every module works on, or undefined when nothing is selected. */
export function useSelectedPatient() {
  return useAppSelector(selectCurrentPatient);
}
