export class BoundedFirstSamples<T> {
  private readonly retainedKeys = new Set<string>();
  private readonly retainedValues: T[] = [];
  private wasTruncated = false;

  constructor(private readonly limit: number) {}

  add(key: string, value: T): void {
    if (this.retainedKeys.has(key)) return;
    if (this.retainedValues.length >= this.limit) {
      this.wasTruncated = true;
      return;
    }
    this.retainedKeys.add(key);
    this.retainedValues.push(value);
  }

  get retainedKeyCount(): number {
    return this.retainedKeys.size;
  }

  get truncated(): boolean {
    return this.wasTruncated;
  }

  values(): T[] {
    return this.retainedValues.slice();
  }
}

export class BoundedLexicographicStringSamples {
  private readonly retained = new Set<string>();
  private sortedValues: string[] = [];
  private wasTruncated = false;

  constructor(private readonly limit: number) {}

  add(value: string): void {
    if (this.retained.has(value)) return;
    if (this.sortedValues.length < this.limit) {
      this.retained.add(value);
      this.sortedValues.push(value);
      this.sortedValues.sort(compareExact);
      return;
    }

    this.wasTruncated = true;
    if (this.limit === 0) return;
    const largest = this.sortedValues[this.sortedValues.length - 1];
    if (compareExact(value, largest) >= 0) return;
    this.retained.delete(largest);
    this.retained.add(value);
    this.sortedValues[this.sortedValues.length - 1] = value;
    this.sortedValues.sort(compareExact);
  }

  get retainedSampleCount(): number {
    return this.retained.size;
  }

  get truncated(): boolean {
    return this.wasTruncated;
  }

  values(): string[] {
    return this.sortedValues.slice();
  }
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
