import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import authReducer from './slices/authSlice';
import patientReducer from './slices/patientSlice';
import providerReducer from './slices/providerSlice';
import uiReducer from './slices/uiSlice';
import voiceReducer from './slices/voiceSlice';
import navigationReducer from './slices/navigationSlice';
import inboxReducer from './slices/inboxSlice';
import monitorReducer from './slices/monitorSlice';
import { appointmentsSlice, diagnosesSlice, medicationsSlice, recallsSlice, tasksSlice } from './slices/recordSlices';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    patients: patientReducer,
    providers: providerReducer,
    medications: medicationsSlice.reducer,
    diagnoses: diagnosesSlice.reducer,
    tasks: tasksSlice.reducer,
    recalls: recallsSlice.reducer,
    appointments: appointmentsSlice.reducer,
    inbox: inboxReducer,
    ui: uiReducer,
    voice: voiceReducer,
    navigation: navigationReducer,
    monitor: monitorReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: false,
    }),
  devTools: import.meta.env.DEV,
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export type AppStore = typeof store;

export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
