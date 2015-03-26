/*
 * quickhull3d
 * https://github.com/maurizzzio/QuickHull-3d
 *
 * Copyright (c) 2015 Mauricio Poppe
 * Licensed under the MIT license.
 */

'use strict';

var glMatrix = require('gl-matrix');
var assert = require('assert');
var debug = require('debug')('quickhull3d:index');
var EventEmitter = require('events').EventEmitter;

var vec3 = glMatrix.vec3;
var utils = require('./lib/utils');
var FaceStore = require('./lib/FaceStore');
var Constants = require('./lib/Constants');

/**
 * Quickhull implementation in 3d, based on the paper
 * http://www.cise.ufl.edu/~ungor/courses/fall06/papers/QuickHull.pdf
 *
 * Features:
 * - O(n log n) average complexity
 * - face visibility test check done in sublinear time (computation of the horizon with
 * dfs)
 *
 * TODO_LIST:
 * - face merging
 *
 * Implementation tips:
 * - Dirk Gregorius presentation:
 * http://box2d.org/files/GDC2014/DirkGregorius_ImplementingQuickHull.pdf
 *
 * @param {vec3[]} points
 */
function CloudPoint(points) {
  EventEmitter.call(this);
  this.points = points || [];
  this.faceStore = new FaceStore(this);
}

CloudPoint.prototype = Object.create(EventEmitter.prototype);

CloudPoint.prototype.quickHull = function (options) {
  options = options || {};
  var i, j, F_LENGTH;
  assert(this.points.length >= 4, 'quickHull needs at least 4 points to work with');

  var extremes = this.computeExtremes();
  var initialIndices = this.computeInitialIndices(extremes);
  var tetrahedron = this.computeInitialTetrahedron(extremes);
  this.assignIndices(tetrahedron, initialIndices);

  // the final faces are the initial faces for now
  var facesToCheck = tetrahedron.slice();
  var faces = this.cull(facesToCheck);
  var results = [];

  // enable garbage collection on the faces that are not in the store
  this.faceStore.reset();

  // build results based on the options
  for (i = 0, F_LENGTH = faces.length; i < F_LENGTH; i += 1) {
    var indices = faces[i].vertexIndexCollection;
    if (options.avoidTriangulation) {
      results.push(indices);
    } else {
      for (j = 1; j < indices.length - 1; j += 1) {
        results.push([indices[0], indices[j], indices[j + 1]]);
      }
    }
  }
  return results;
};

CloudPoint.prototype.computeExtremes = function () {
  var points = this.points;
  // indices of the extremes
  var v0, v1, v2, v3;
  var i, j;
  // variable to a temporal distance
  var tDist;
  // distance from point to the origin
  var distPO;
  var maxDistance;
  var normal;

  var P_LENGTH = points.length;
  var axisAlignedExtremes = [
    // min (x, y, z)
    0, 0, 0,
    // max (x, y, z)
    0, 0, 0
  ];

  // find extremes
  for (i = 0; i < P_LENGTH; i += 1) {
    for (j = 0; j < 3; j += 1) {
      // min
      if (points[i][j] < points[axisAlignedExtremes[j]][j]) {
        axisAlignedExtremes[j] = i;
      }
      // max
      if (points[i][j] > points[axisAlignedExtremes[j + 3]][j]) {
        axisAlignedExtremes[j + 3] = i;
      }
    }
  }

  // find the longest distance between the extremes
  maxDistance = 0;
  for (i = 0; i < 6; i += 1) {
    for (j = i + 1; j < 6; j += 1) {
      tDist = vec3.squaredDistance(
        points[axisAlignedExtremes[i]],
        points[axisAlignedExtremes[j]]
      );
      if (tDist > maxDistance) {
        maxDistance = tDist;
        v0 = axisAlignedExtremes[i];
        v1 = axisAlignedExtremes[j];
      }
    }
  }

  // eps
  Constants.EPS = 0;
  for (i = 0; i < 3; i += 1) {
    Constants.EPS += points[axisAlignedExtremes[i + 3]][i] -
      points[axisAlignedExtremes[i]][i];
  }
  Constants.EPS = 3 * Constants.EPS * Constants.DOUBLE_EPS;

  // find the most distant point to the segment (v0,v1)
  // such a point is one of the extremes already found
  maxDistance = -1;
  for (i = 0; i < 6; i += 1) {
    tDist =  utils.squaredDistanceToSegmentFromPoint(
      points[v0], points[v1], points[axisAlignedExtremes[i]]
    );
    if (tDist > maxDistance) {
      maxDistance = tDist;
      v2 = axisAlignedExtremes[i];
    }
  }

  // find the most distant point to the plane (v0,v1,v2)
  normal = utils.normal(points[v0], points[v1], points[v2]);
  // distance from the origin to the plane (v0,v1,v2)
  distPO = vec3.dot(normal, points[v0]);
  maxDistance = -1;
  for (i = 0; i < P_LENGTH; i += 1) {
    // v3 can't be v0,v1,v2
    if (v0 !== i && v1 !== i && v2 !== i) {
      tDist = Math.abs(vec3.dot(normal, points[i]) - distPO);
      if (tDist > maxDistance) {
        maxDistance = tDist;
        v3 = i;
      }
    }
  }

  return [v0, v1, v2, v3];
};

CloudPoint.prototype.computeInitialTetrahedron = function (extremes, indices) {
  var me = this;
  var points = this.points;
  var v0 = extremes[0];
  var v1 = extremes[1];
  var v2 = extremes[2];
  var v3 = extremes[3];
  var ab = vec3.create();
  var ac = vec3.create();
  var ad = vec3.create();
  var normal = vec3.create();

  // Taken from http://everything2.com/title/How+to+paint+a+tetrahedron
  //
  //                              v2
  //                             ,|,
  //                           ,7``\'VA,
  //                         ,7`   |, `'VA,
  //                       ,7`     `\    `'VA,
  //                     ,7`        |,      `'VA,
  //                   ,7`          `\         `'VA,
  //                 ,7`             |,           `'VA,
  //               ,7`               `\       ,..ooOOTK` v3
  //             ,7`                  |,.ooOOT''`    AV
  //           ,7`            ,..ooOOT`\`           /7
  //         ,7`      ,..ooOOT''`      |,          AV
  //        ,T,..ooOOT''`              `\         /7
  //     v0 `'TTs.,                     |,       AV
  //            `'TTs.,                 `\      /7
  //                 `'TTs.,             |,    AV
  //                      `'TTs.,        `\   /7
  //                           `'TTs.,    |, AV
  //                                `'TTs.,\/7
  //                                     `'T`
  //                                       v1
  //
  var tetrahedron = [
    // assume that each face's normal points outside
    this.faceStore.create(points, v0, v1, v2),    // left
    this.faceStore.create(points, v1, v3, v2),    // right
    this.faceStore.create(points, v0, v3, v1),    // bottom
    this.faceStore.create(points, v0, v2, v3)     // back
  ];

  // set neighbors
  var left = tetrahedron[0];
  var right = tetrahedron[1];
  var bottom = tetrahedron[2];
  var back = tetrahedron[3];

  // fix each face if it's normal points inside
  // ((b - a) x (c - a)) · d if positive then the any face's normal
  // is pointing inside (tested with tetrahedron[0])
  vec3.sub(ab, points[v1], points[v0]);
  vec3.sub(ac, points[v2], points[v0]);
  vec3.sub(ad, points[v3], points[v0]);
  vec3.cross(normal, ab, ac);
  if (vec3.dot(normal, ad) > 0) {
    tetrahedron[0].invert();
    tetrahedron[1].invert();
    tetrahedron[2].invert();
    tetrahedron[3].invert();
  }

  // double link between twins created on updateTwins, no need to call it many times
  left.updateTwins(right, bottom, back);
  right.updateTwins(bottom, back);
  bottom.updateTwins(back);

  return tetrahedron;
};

CloudPoint.prototype.assignIndices = function (faces, indices) {
  var i, j, INDICES = indices.length, FACES = faces.length;
  var tDist;

  // lemma 2.2 (If an extreme point of the input is above two or more facets at
  // a partition step in Quickhull, it will be added to the hull irrespective of
  // which outside set it is assigned to.)
  debug('indices to assign: %j', indices);
  for (i = 0; i < INDICES; i += 1) {
    for (j = 0; j < FACES; j += 1) {
      tDist = vec3.dot(faces[j].normal, this.points[indices[i]]) -
        faces[j].signedDistanceToOrigin;
      if (tDist > 0) {
        debug('\tindex to face: index=%d -> face=%d', indices[i], faces[j].id);
        faces[j].addVisiblePoint(indices[i], tDist);
        break;
      }
    }
  }
};

CloudPoint.prototype.computeInitialIndices = function (extremes) {
  var POINT_LENGTH = this.points.length;
  var initialIndices = [];
  var i;
  for (i = 0; i < POINT_LENGTH; i += 1) {
    if (extremes.indexOf(i) === -1) {
      initialIndices.push(i);
    }
  }
  return initialIndices;
};

CloudPoint.prototype.computeHorizon = function (initialFace, point) {
  var me = this;
  var visibleFaces = [];
  var horizonEdges = [];

  debug('horizon start %j', point);
  function dfs(face, startEdge) {
    var nextFace;
    var it = startEdge;

    face.destroy();
    me.emit('face:destroy', face);
    visibleFaces.push(face);

    do {
      assert(it.twin);
      nextFace = it.twin.face;
      if (!nextFace.destroyed) {
        if (vec3.dot(point, nextFace.normal) > nextFace.signedDistanceToOrigin) {
          // the face is able to see the point
          dfs(nextFace, it.twin);
        } else {
          // if the new face can't be seen that means we have found an edge
          // that is part of the horizon, common edge is an array with the indexes
          // of the points that are part of the edge
          horizonEdges.push(it);
        }
      }

      it = it.next;
    } while (it !== startEdge);
  }

  //console.log(initialFace.vertexIndexCollection);
  dfs(initialFace, initialFace.edge);

  return {
    horizonEdges: horizonEdges,
    visibleFaces: visibleFaces
  };
};

CloudPoint.prototype.cull = function (facesToCheck) {
  var me = this;
  var points = this.points;
  var currentFace, i, j, edge, newFace, LENGTH;
  var tuple;
  var visibleFaces, horizonEdges;
  var indicesToAssign, pointIndex;

  function gatherIndicesFromFaces(faces) {
    var i;
    var FACES_LENGTH = faces.length;
    var indexes = [];
    for (i = 0; i < FACES_LENGTH; i += 1) {
      assert(faces[i].destroyed);
      indexes = indexes.concat(faces[i].visibleIndices);
      faces[i].visibleIndices = [];
    }
    return indexes;
  }

  while (facesToCheck.length) {
    currentFace = facesToCheck.shift();
    debug('== iteration ==');
    debug('current face=%d, vertices=%j, visibleIndices=%j',
      currentFace.id, currentFace.vertexIndexCollection, currentFace.visibleIndices);

    assert(currentFace.visibleIndices);
    if (!currentFace.destroyed && currentFace.visibleIndices.length) {
      // index of the closest point to the current face
      // shift it since it's no longer assignable to the other faces
      pointIndex = currentFace.visibleIndices.shift();
      debug('\tpoint index to join edges=%d', pointIndex);

      // compute the visible faces and the horizon edges
      tuple = this.computeHorizon(currentFace, points[pointIndex]);
      //debug('\ttuple edges=%j faces=%j', tuple.edges, tuple.visibleFaces.map(function (face) { return face.id }));
      visibleFaces = tuple.visibleFaces;
      horizonEdges = tuple.horizonEdges;

      // args: Array[], an array with the indices of each face
      //me.emit('visibleFaces', tuple.visibleFaces.map(function (face) {
      //  return face.indices;
      //}));
      // args: Array[] Array of 2-element arrays, there's an edge between those two elements
      //me.emit('horizon', tuple.edges);

      // from all the visible faces obtain the list of point indexes
      // to distribute them among all the new faces
      indicesToAssign = gatherIndicesFromFaces(visibleFaces);

      var newFaces = [];
      for (i = 0, LENGTH = horizonEdges.length; i < LENGTH; i += 1) {
        edge = horizonEdges[i];
        // since every face is created using the right hand rule there's no need
        // to check where the normal of this face is pointing to
        newFace = this.faceStore.create(points, edge.prev.vertex, edge.vertex, pointIndex);
        newFaces.push(newFace);
      }

      for (j = LENGTH - 1, i = 0; i < LENGTH; j = i, i += 1) {
        newFace = newFaces[i];
        // new face with new face
        newFaces[j].updateTwins(newFace);
        // new face with horizon face (which is accessible through the twin's reference)
        // face merge is done in updateTwins
        horizonEdges[i].twin.face.updateTwins(newFace);

        // only push a new face when there weren't any merges
        //debug('pushing new face %d, %j', newFace.id, newFace.vertexIndexCollection);
        facesToCheck.push(newFace);
      }
      this.assignIndices(newFaces, indicesToAssign);
    }
  }

  return this.faceStore.getFacesNotDestroyed();
};

module.exports = CloudPoint;

module.exports.run = function (points, options) {
  return new CloudPoint(points).quickHull(options);
};

module.exports.Face = require('./lib/Face');
