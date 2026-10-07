import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { App as AntApp, ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import { store } from '@/store';
import { antdTheme } from '@/theme/antdTheme';
import { getVoiceController, initVoiceController } from '@/services/ai/voiceController';
import { publishMonitor, STARTED_AS_MONITOR } from '@/services/ai/monitor/channel';

// The voice controller is a long-lived singleton bound to the store.
initVoiceController(store);
// Agent Monitoring may be open in its own window: send it what the agents of this window do.
// A monitor in another tab may also ask this window to stop its agents (Stop & clear).
if (!STARTED_AS_MONITOR) publishMonitor(store, { onStop: () => void getVoiceController().stopAll() });

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <Provider store={store}>
      <ConfigProvider theme={antdTheme} locale={enUS} componentSize="middle">
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </Provider>
  );
}
