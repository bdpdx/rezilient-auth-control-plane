export interface Clock {
    now(): Date;
}

export class SystemClock implements Clock {
    now(): Date {
        return new Date();
    }
}

export class FixedClock implements Clock {
    private current: Date;

    constructor(initialIsoDateTime: string) {
        this.current = new Date(initialIsoDateTime);
    }

    now(): Date {
        return new Date(this.current.toISOString());
    }

    advanceSeconds(seconds: number): void {
        this.current = new Date(this.current.getTime() + (seconds * 1000));
    }

    set(isoDateTime: string): void {
        this.current = new Date(isoDateTime);
    }
}
