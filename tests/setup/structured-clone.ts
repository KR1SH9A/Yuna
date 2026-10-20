/**
 * Jest exposes Node's host-realm structuredClone inside its VM. Its cloned plain objects then
 * fail copyJson's prototype checks, unlike production where both operations share a realm.
 * Keep native cloning (including errors and transfer handling), then repair only JSON container
 * prototypes on the detached result. This is not a general polyfill for other native types.
 * Upstream: https://github.com/jestjs/jest/issues/14947
 */
const nativeStructuredClone = globalThis.structuredClone;
const nativeObjectPrototype = Object.getPrototypeOf(nativeStructuredClone({}));

/** Walk only cloned arrays/plain objects; preserve aliases, cycles, sparse entries and values. */
function restoreJsonContainerPrototypes(value: unknown, visited: WeakSet<object>): void {
  if (value === null || typeof value !== 'object' || visited.has(value)) return;
  if (Array.isArray(value)) {
    Object.setPrototypeOf(value, Array.prototype);
  } else if (Object.getPrototypeOf(value) === nativeObjectPrototype) {
    Object.setPrototypeOf(value, Object.prototype);
  } else {
    return;
  }
  visited.add(value);
  for (const child of Object.values(value)) restoreJsonContainerPrototypes(child, visited);
}

if (nativeObjectPrototype !== Object.prototype) {
  globalThis.structuredClone = (value, options) => {
    const cloned = nativeStructuredClone(value, options);
    restoreJsonContainerPrototypes(cloned, new WeakSet());
    return cloned;
  };
}

export {};
