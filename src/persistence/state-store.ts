import { ControlPlaneState } from './types';

export interface ControlPlaneStateStore {
    read(): ControlPlaneState;
    mutate<T>(mutator: (state: ControlPlaneState) => T): T;
}
