import AbstractClass from '../AbstractClass/index.js';

class Model extends AbstractClass {
  constructor () {
    super();
    this.eventHandlers = {};
    this.stickyTriggers = {};
  }
  on (eventName, callback, allowDuplicateListeners) {
    if (!this.eventHandlers[eventName]) {
      this.eventHandlers[eventName] = [];
    }
    if (!allowDuplicateListeners) {
      if (this.eventHandlers[eventName].indexOf(callback) !== -1) {
        return;
      }
    }
    this.eventHandlers[eventName].push(callback);
  }
  off (eventName, callback) {
    if (this.eventHandlers[eventName]) {
      if (!callback) {
        delete this.eventHandlers[eventName];
      } else {
        let index = this.eventHandlers[eventName].indexOf(callback);
        if (index >= 0) {
          this.eventHandlers[eventName].splice(index, 1);
        }
      }
    }
  }
  trigger (eventName, ...args) {
    if (this.eventHandlers[eventName]) {
      this.eventHandlers[eventName].forEach(callback => {
        window.setTimeout(() => { // Add timeout to prevent blocking
          callback.apply(this, args);
        }, 0);
      });
    }
  }
  stickyTrigger (eventName, argObj, delay = 10) {
    this.stickyTriggers[eventName] = this.stickyTriggers[eventName] || { argObj: {} };
    Object.assign(this.stickyTriggers[eventName].argObj, argObj);
    window.clearTimeout(this.stickyTriggers.timeout);
    this.stickyTriggers.timeout = window.setTimeout(() => {
      let argObj = this.stickyTriggers[eventName].argObj;
      delete this.stickyTriggers[eventName];
      this.trigger(eventName, argObj);
    }, delay);
  }
}

export default Model;
