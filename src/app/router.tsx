import { lazy } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Button, Result } from 'antd';
import { useAppSelector } from '@/store';
import { AppLayout } from '@/components/layout/AppLayout';

const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const PatientModulePage = lazy(() => import('@/pages/PatientModulePage'));
const SummaryPage = lazy(() => import('@/pages/SummaryPage'));
const InboxPage = lazy(() => import('@/pages/InboxPage'));
const ConfigurationPage = lazy(() => import('@/pages/ConfigurationPage'));
const AgentMonitoringPage = lazy(() => import('@/pages/AgentMonitoringPage'));
const ProviderAppointmentsPage = lazy(() => import('@/pages/ProviderAppointmentsPage'));
const LoginPage = lazy(() => import('@/pages/LoginPage'));

function RequireAuth() {
  const status = useAppSelector((s) => s.auth.status);
  const location = useLocation();
  if (status !== 'authenticated') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}


function NotFound() {
  return (
    <Result
      status="404"
      title="Page not found"
      subTitle="This application has Dashboard, Patients, Inbox, Summary and Configuration."
      extra={
        <Button type="primary" href="/dashboard">
          Back to dashboard
        </Button>
      }
    />
  );
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      // Agent Monitoring: a page of its own — no sidebar, no header — to sit beside the app in a second window.
      { path: '/agent-monitor', Component: AgentMonitoringPage },
      {
        element: <AppLayout />,
        children: [
          // The front door is the signed-in provider's own dashboard.
          { index: true, element: <Navigate to="/dashboard" replace /> },
          // These work without a selected patient: the Dashboard is the provider's
          // own view, the Patient module is where the patient is chosen, and the
          // Inbox is a provider workqueue that spans patients.
          { path: '/dashboard', Component: DashboardPage },
          { path: '/patients', Component: PatientModulePage },
          { path: '/configuration', Component: ConfigurationPage },
          // Agent Monitoring opens in its own window now (/agent-monitor); the old address leads there.
          { path: '/configuration/monitoring', element: <Navigate to="/agent-monitor" replace /> },
          // The provider's own appointments (patients' appointments are in each patient's Summary).
          { path: '/schedule', Component: ProviderAppointmentsPage },
          { path: '/inbox', element: <Navigate to="/inbox/all" replace /> },
          { path: '/inbox/:category', Component: InboxPage },
          // The Summary opens without a selected patient too: records added there name their
          // patient in the form, and each tab says when there is no patient to show.
          { path: '/summary', Component: SummaryPage },
          { path: '/summary/:tab', Component: SummaryPage },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);
