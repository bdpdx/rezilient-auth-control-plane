import { ControlPlaneStateStore } from './state-store';
import {
    cloneControlPlaneState,
    ControlPlaneState,
    createEmptyControlPlaneState,
} from './types';

export class InMemoryControlPlaneStateStore implements ControlPlaneStateStore {
    private state: ControlPlaneState;

    constructor(initialState?: ControlPlaneState) {
        const sourceState = initialState ?? createEmptyControlPlaneState();
        this.state = cloneControlPlaneState(sourceState);
    }

    async read(): Promise<ControlPlaneState> {
        return cloneControlPlaneState(this.state);
    }

    async mutate<T>(
        mutator: (state: ControlPlaneState) => T | Promise<T>,
    ): Promise<T> {
        const workingState = cloneControlPlaneState(this.state);
        const result = await mutator(workingState);
        this.state = workingState;

        return result;
    }

    async close(): Promise<void> {
        return Promise.resolve();
    }
}
