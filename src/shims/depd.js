export default function depd(namespace) {
  if (!namespace) {
    throw new TypeError('argument namespace is required');
  }

  function deprecate() {
    // no-op in browser
  }

  deprecate._file = undefined;
  deprecate._ignored = true;
  deprecate._namespace = namespace;
  deprecate._traced = false;
  deprecate._warned = Object.create(null);

  deprecate.function = function (fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('argument fn must be a function');
    }
    return fn;
  };

  deprecate.property = function (obj, prop) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
      throw new TypeError('argument obj must be object');
    }

    const descriptor = Object.getOwnPropertyDescriptor(obj, prop);

    if (!descriptor) {
      throw new TypeError('must call property on owner object');
    }

    if (!descriptor.configurable) {
      throw new TypeError('property must be configurable');
    }
  };

  return deprecate;
}
