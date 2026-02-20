import { ControlPlaneState } from './types';

export interface ControlPlaneStateStore {
    read(): Promise<ControlPlaneState>;
    mutate<T>(
        mutator: (state: ControlPlaneState) => T | Promise<T>,
    ): Promise<T>;
    close?(): Promise<void>;
}
