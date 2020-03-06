'use strict';

const PropertyUtils = require('./property-utils');

const CharacteristicMapByUuid = {
  // Eve Motion
  'E863F120-079E-48FF-8F27-9C2605A29F52': {
    property: {
      title: 'Sensitivity',
      type: 'string',
      enum: [
        'High',
        'Medium',
        'Low',
      ],
    },
    getter: PropertyUtils.buildEnumGetter({
      0: 'High',
      4: 'Medium',
      7: 'Low',
    }),
    setter: PropertyUtils.buildEnumSetter({
      0: 'High',
      4: 'Medium',
      7: 'Low',
    }),
  },
  'E863F12D-079E-48FF-8F27-9C2605A29F52': {
    property: {
      title: 'Duration',
      type: 'integer',
      unit: 'seconds',
    },
  },

  // Eve Energy
  'E863F10A-079E-48FF-8F27-9C2605A29F52': {
    property: {
      title: 'Voltage',
      '@type': 'VoltageProperty',
      unit: 'volt',
      type: 'number',
      readOnly: true,
    },
  },
  'E863F126-079E-48FF-8F27-9C2605A29F52': {
    property: {
      title: 'Current',
      '@type': 'CurrentProperty',
      unit: 'ampere',
      type: 'number',
      readOnly: true,
    },
  },
  'E863F10D-079E-48FF-8F27-9C2605A29F52': {
    property: {
      title: 'Power',
      '@type': 'InstantaneousPowerProperty',
      unit: 'watt',
      type: 'number',
      readOnly: true,
    },
  },
  'E863F10C-079E-48FF-8F27-9C2605A29F52': {
    property: {
      title: 'Total Consumption',
      unit: 'kilowatt-hour',
      type: 'number',
      readOnly: true,
    },
  },
};

module.exports = {
  CharacteristicMapByUuid,
};
