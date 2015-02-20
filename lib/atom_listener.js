/*jslint nomen: true, todo: true */
"use strict";

var flux = require("flukes"),
  fs = require("fs"),
  _ = require('lodash'),
  path = require("path"),
  DMP = require("diff_match_patch"),
  editorAction = require('./common/editor_action'),
  bufferAction = require('./common/buffer_action'),
  Range = require("atom").Range,
  CompositeDisposable = require('atom').CompositeDisposable,
  util = require('util');

var floop = require("./common/floop"),
  utils = require("./utils");

var AtomListener = function (bufs, users) {
  this.bufs = bufs;
  this.users = users;
  this.editorID_ =  0;
  this.atomEditors = {};
  this.atomBuffers = {};
  this.disposables = null;
  this.send_patch_for = {};
  this.highlights = {};
};

AtomListener.prototype.onDidChange = function (buffer, change) {
  console.log("changed");
  if (this.ignore_events) {
    return;
  }

  if (!buffer.floobitsID) {
    console.warn(buffer.getPath(), " is in project but not shared (and it changed).");
  }
  this.send_patch_for[buffer.floobitsID] = true;
};

AtomListener.prototype.onDidStopChanging = function (buffer) {
  var fluffer;

  if (!floop.connected || !this.send_patch_for[buffer.floobitsID]) {
    return;
  }

  this.send_patch_for[buffer.floobitsID] = false;

  fluffer = this.bufs.get(buffer.floobitsID);

  if (!fluffer || !fluffer.populated) {
    return;
  }

  console.log("really changed");
  fluffer.send_patch([buffer.getText()]);
};

AtomListener.prototype.onDidSave = function (buffer) {
  var self = this,
    fluffer = this.bufs.get(buffer.floobitsID);

  if (self.ignore_events || !fluffer || !fluffer.populated) {
    return;
  }
  // TODO: this can happen before we send a patch!
  floop.send_saved({id: fluffer.id});
};

AtomListener.prototype.onDidChangeSelectionRange = function (editor) {
  var range, start, end,
    fluffer = this.bufs.get(editor.floobitsID),
    selections = editor.selections;

  if (selections.length <= 0) {
    return;
  }

  if (!fluffer || !fluffer.populated) {
    return;
  }
  // TODO: rate limit
  floop.send_highlight({
    'id': fluffer.id,
    'ping': false,
    'summon': false,
    'following': false,
    'ranges': _.map(selections, function (selection) {
      var range = selection.getBufferRange(),
        start = editor.buffer.characterIndexForPosition(range.start),
        end = editor.buffer.characterIndexForPosition(range.end);
      return [start, end];
    })
  });
};

AtomListener.prototype.onDidChangeCursorPosition = function (editor) {
  return editor;
};

AtomListener.prototype.onDidChangePath = function (editor) {
  var isEditor = editor.buffer,
    oldFluffer = this.bufs.get(editor.floobitsID),
    fluffer = this.bufs.findFluffer(editor),
    oldPath, floobitsID;

  if (oldFluffer) {
    oldPath = oldFluffer.path;
  }

  editor.floobitsID = fluffer ? fluffer.id : -1;
  if (isEditor) {
    return;
  }

  if (oldPath) {
    // TODO: send event
    return;
  }
  if (fluffer) {
    // TODO: check to see if its shared 
  }
};

AtomListener.prototype.bindTo_ = function (obj, events) {
  var that = this,
    disposables = new CompositeDisposable();

  _.each(events, function (eventName) {
    var d;

    function action () {
      var args = _.toArray(arguments);
      args.unshift(obj);
      that[eventName].apply(that, args);
    }
    disposables.add(obj[eventName](action));
  });
  this.disposables.add(disposables);

  obj.onDidDestroy(function () {
    disposables.dispose();
    that.disposables.remove(disposables);
    delete obj.floobitsID;
  });
};
AtomListener.prototype.stop = function () {
  this.disposables.dispose();
  this.disposables = null;
};

AtomListener.prototype.on_floobits_saved = function (data) {

};

AtomListener.prototype.on_floobits_highlight = function (data) {
  var fluffer, editors, highlights = this.highlights;

  if (!data || _.size(data.ranges) === 0) {
    return;
  }

  fluffer = this.bufs.get(data.id);

  if (!fluffer || !fluffer.populated) {
    return;
  }

  var markers = highlights[data.username];
  if (markers) {
    markers.forEach(function (m) {
      try {
        m.destroy();
      } catch (e) {
        console.log(e);
      }
    });
    delete highlights[data.username];
  }
  
  editors = this.atomEditors[data.id];
  
  if (!editors || !editors.length) {
    return;
  }
  highlights[data.username] = [];

  var klass = "floobits-highlight-dark_" + utils.user_color(data.username);

  _.each(editors, function (editor) {
    var buffer, offsetIndex;

    buffer = editor.buffer;
    if (!buffer) {
      return;
    }

    offsetIndex = buffer.offsetIndex;

    _.map(data.ranges, function (range) {
      var startRow, endRow, colStart, colEnd, line;
      startRow = offsetIndex.totalTo(range[0], 'characters').rows;
      colStart = range[0] - offsetIndex.totalTo(startRow, "rows").characters;
      endRow   = offsetIndex.totalTo(range[1], 'characters').rows;
      colEnd = range[1] - offsetIndex.totalTo(endRow, "rows").characters;
      console.log([startRow, colStart], [endRow, colEnd]);
      if (startRow === endRow && colStart === colEnd) {
        line = buffer.lineForRow(endRow);
        if (line && line.length == colEnd) {
          colStart -= 1;
        } else {
          colEnd += 1;
        }
      }
      return new Range([startRow, colStart], [endRow, colEnd]);
    }).forEach(function (r) {
      var marker;
      console.log("marking", r);
      marker = editor.markBufferRange(r, {invalidate: 'never'});
      editor.decorateMarker(marker, {type: "highlight", class: klass});
      highlights[data.username].push(marker);
    });
  });

  this.lastHighlight = data;
};

AtomListener.prototype.observeTextEditors = function (editor) {
  var p, fluffer, buffer, id, that = this;

  // bad stuff happens if we throw here
  try {
    // TODO: store the disposables somewhere convenient to unhook
    that.bindTo_(editor, ["onDidChangeSelectionRange", "onDidChangeCursorPosition"]);
    
    fluffer = that.bufs.findFluffer(editor);

    if (!fluffer) {
      id = -1;
    } else {
      id = fluffer.id;
    }
    // TODO: store these by path instead so we can handle new buffer creation?
    that.editors_to_buffers[editor.id] = id;

    if (!(id in that.atomEditors)) {
      that.atomEditors[id] = [];
    }

    that.atomEditors[id].push(editor);
    
    buffer = editor.getBuffer();
    // editors to buffers is many to one
    if (_.has(buffer, "floobitsID")) {
      return;
    }
    
    buffer.floobitsID = id;
    // TODO: maybe check to see if one is there first?
    that.atomBuffers[id] = buffer;

    that.bindTo_(buffer, ["onDidChangePath", "onDidSave", "onDidStopChanging", "onDidChange"]);  
  } catch (e) {
    console.error(e);
  }
  
};

AtomListener.prototype.start = function () {
  var that = this, d;

  this.disposables = new CompositeDisposable();

  this.editors_to_buffers = {};

  d = atom.workspace.observeTextEditors(this.observeTextEditors.bind(this));
  this.disposables.add(d);
  floop.onHIGHLIGHT(this.on_floobits_highlight.bind(this));
  bufferAction.onDELETED(function (b, force) {
    // TODO: unbind 
    delete that.atomBuffers[b.id];
    if (!force) {
      return;
    }
    that.ignore_events = true;
    try {
      fs.unlinkSync(b.abs_path());
    } catch (e) {
      console.error(e);
    }
    that.ignore_events = false;
  });
  bufferAction.onSAVED(function (b) {
    var buffer = that.atomBuffers[b.id];
    if (!buffer || !buffer.isAlive()) {
      return;
    }
    that.ignore_events = true;
    buffer.save();
    that.ignore_events = false;
  });
  bufferAction.onCHANGED(function (b) {
    var buffer = that.atomBuffers[b.id];

    if (!b.populated) {
      return;
    }

    that.ignore_events = true;

    try {
      if (!buffer || !buffer.isAlive()) {
        fs.writeFileSync(b.abs_path(), b.buf);
      } else {
        buffer.setText(b.buf);
        if (b.shouldSave) {
          buffer.save();
        }
      }
    } catch (e) {
      console.error(e);
    }

    b.shouldSave = false;
    that.ignore_events = false;
  });
};

module.exports = AtomListener;