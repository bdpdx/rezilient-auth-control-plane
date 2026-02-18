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

    read(): ControlPlaneState {
        return cloneControlPlaneState(this.state);
    }

    mutate<T>(mutator: (state: ControlPlaneState) => T): T {
        const workingState = cloneControlPlaneState(this.state);
        const result = mutator(workingState);
        this.state = workingState;

        return result;
    }
}
