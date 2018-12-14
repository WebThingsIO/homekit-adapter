'use strict';

/**
* Build an enum property value getter.
*
* @param {Object} values - Enum values, i.e. {0: 'val1', ...}
* @returns {function} New function.
*/
function buildEnumGetter(values) {
  return (value) => {
    if (values.hasOwnProperty(value)) {
      return values[value];
    }

    throw new Error('Invalid enum value');
  };
}

/**
* Build an enum property value setter.
*
* @param {Object} values - Enum values, i.e. {0: 'val1', ...}
* @returns {function} New function.
*/
function buildEnumSetter(values) {
  return (value) => {
    const v = Object.entries(values).find((entry) => {
      if (entry[1] === value) {
        return true;
      }
    });

    if (v) {
      return parseInt(v[0], 10);
    }

    throw new Error('Invalid enum value');
  };
}

module.exports = {
  buildEnumGetter,
  buildEnumSetter,
};
