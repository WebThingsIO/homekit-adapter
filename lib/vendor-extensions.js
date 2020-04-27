'use strict';

const PropertyUtils = require('./property-utils');

const CharacteristicMapByUuid = {
  // Eve Motion
  'E863F120-079E-48FF-8F27-9C2605A29F52': {
    property: {
      meta: {
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
  },
  'E863F12D-079E-48FF-8F27-9C2605A29F52': {
    property: {
      meta: {
        title: 'Duration',
        type: 'integer',
        unit: 'seconds',
      },
    },
  },

  // Eve Energy
  'E863F10A-079E-48FF-8F27-9C2605A29F52': {
    property: {
      meta: {
        title: 'Voltage',
        '@type': 'VoltageProperty',
        unit: 'volt',
        type: 'number',
        multipleOf: 0.1,
        readOnly: true,
      },
    },
  },
  'E863F126-079E-48FF-8F27-9C2605A29F52': {
    property: {
      meta: {
        title: 'Current',
        '@type': 'CurrentProperty',
        unit: 'ampere',
        type: 'number',
        multipleOf: 0.1,
        readOnly: true,
      },
    },
  },
  'E863F10D-079E-48FF-8F27-9C2605A29F52': {
    property: {
      meta: {
        title: 'Power',
        '@type': 'InstantaneousPowerProperty',
        unit: 'watt',
        type: 'number',
        multipleOf: 0.1,
        readOnly: true,
      },
    },
  },
  'E863F10C-079E-48FF-8F27-9C2605A29F52': {
    property: {
      meta: {
        title: 'Total Consumption',
        unit: 'kilowatt-hour',
        type: 'number',
        multipleOf: 0.1,
        readOnly: true,
      },
    },
  },

  // Ecobee
  '1B300BC2-CFFC-47FF-89F9-BD6CCF5F2853': {
    property: {
      meta: {
        title: 'Preset',
        type: 'string',
        enum: [
          'Home',
          'Sleep',
          'Away',
        ],
        visible: false,
      },
      getter: () => null,
      setter: PropertyUtils.buildEnumSetter({
        0: 'Home',
        1: 'Sleep',
        2: 'Away',
      }),
    },
    action: {
      name: 'preset',
      meta: {
        title: 'Set Preset',
        description: 'Override program with preset',
        input: {
          type: 'string',
          enum: [
            'Home',
            'Sleep',
            'Away',
          ],
        },
      },
      callback: (device, action) => {
        for (const prop of device.properties.values()) {
          if (prop.title === 'Preset') {
            prop.setValue(action.input);
            break;
          }
        }
      },
    },
  },
  'FA128DE6-9D7D-49A4-B6D8-4E4E234DEE38': {
    property: {
      meta: {
        title: 'Resume',
        type: 'boolean',
        visible: false,
      },
      getter: () => null,
      setter: (v) => v ? 1 : 0,
    },
    action: {
      name: 'resume',
      meta: {
        title: 'Resume Program',
        description: 'Resume scheduled program',
      },
      callback: (device) => {
        for (const prop of device.properties.values()) {
          if (prop.title === 'Resume') {
            prop.setValue(true);
            break;
          }
        }
      },
    },
  },
};

module.exports = {
  CharacteristicMapByUuid,
};
