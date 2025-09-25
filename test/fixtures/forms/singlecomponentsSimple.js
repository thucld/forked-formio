'use strict';

module.exports = {
  components: [
    {
      label: "Text Field",
      applyMaskOn: "change",
      tableView: true,
      validateWhenHidden: false,
      key: "textField",
      type: "textfield",
      input: true
    }
  ],
  submission: {
    textField: 'test value',
  }
};