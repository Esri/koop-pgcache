var ngeohash = require('ngeohash')
var centroid = require('turf-centroid')
var Geoservices = require('./geoservices')

var Geohash = {
  precision: 8,
  query: null
}

/**
 * Creates a geohash from a features
 * computes the centroid of lines and polygons
 *
 * @param {Object} feature - a geojson feature
 * @param {number} precision - the precision at which the geohash will be created
 * @returns {string} geohash
 */
Geohash.create = function (feature, precision) {
  if (!feature.geometry || !feature.geometry.coordinates) return null
  if (feature.geometry.type !== 'Point') {
    feature = centroid(feature)
  }
  var pnt = feature.geometry.coordinates
  return ngeohash.encode(pnt[1], pnt[0], precision)
}

/**
 * Get a geohash aggregation for a set of features in the db
 * this will auto-reduce the precision of the geohashes if the given
 * precision exceeds the given limit.
 *
 * @param {string} table - the table to query
 * @param {number} limit - the max number of geohash to send back
 * @param {string} precision - the precision at which to extract geohashes
 * @param {Object} options - optional params like where and geometry
 * @param {function} callback - the callback when the query returns
 */
Geohash.aggregate = function (table, limit, precision, options, callback) {
  var self = this
  options.whereFilter = null
  options.geomFilter = null

  // parse the where clause
  if (options.where) {
    if (options.where !== '1=1') {
      var clause = Geoservices.parseWhere(options.where)
      options.whereFilter = ' WHERE ' + clause
    } else {
      options.whereFilter = ' WHERE ' + options.where
    }
    // replace ilike and %% for faster filter queries...
    options.whereFilter = options.whereFilter.replace(/ilike/g, '=').replace(/%/g, '')
  }

  var box = Geoservices.parseGeometry(options.geometry)
  // parse the geometry into a bbox
  if (box) {
    var bbox = box.xmin + ' ' + box.ymin + ',' + box.xmax + ' ' + box.ymax
    options.geomFilter = " ST_GeomFromGeoJSON(feature->>'geometry') && ST_SetSRID('BOX3D(" + bbox + ")'::box3d,4326)"
  }

  var agg = {}

  reducePrecision(table, precision, options, limit, function (err, newPrecision) {
    if (err) return callback(err)

    var geoHashSelect

    if (newPrecision <= precision) {
      geoHashSelect = 'substring(geohash,0,' + (newPrecision) + ')'
    } else {
      geoHashSelect = 'geohash'
    }

    var sql = 'SELECT count(id) as count, ' + geoHashSelect + ' as geohash from "' + table + '"'

    // apply any filters to the sql
    if (options.whereFilter) {
      sql += options.whereFilter
    }
    if (options.geomFilter) {
      sql += ((options.whereFilter) ? ' AND ' : ' WHERE ') + options.geomFilter
    }

    sql += ' GROUP BY ' + geoHashSelect
    self.query(sql, function (err, res) {
      if (!err && res && res.rows.length) {
        res.rows.forEach(function (row) {
          agg[row.geohash] = row.count
        })
        callback(err, agg)
      } else {
        callback(err, res)
      }
    })
  })
}

// recursively get geohash counts until we have a precision
// that reutrns less than the row limit
// this will return the precision that will return the number
// of geohashes less than the limit
function reducePrecision (table, p, options, limit, callback) {
  countDistinctGeoHash(table, p, options, function (err, count) {
    if (parseInt(count, 0) > limit) {
      reducePrecision(table, p - 1, options, limit, callback)
    } else {
      callback(err, p)
    }
  })
}

/**
 * Get the count of distinct geohashes for a query
 *
 * @param {string} table - the table to query
 * @param {string} precision - the precision at which to extract the distinct geohash counts
 * @param {Object} options - optional params like where and geometry
 * @param {function} callback - the callback when the query returns
 */
function countDistinctGeoHash (table, precision, options, callback) {
  var countSql = 'select count(DISTINCT(substring(geohash,0,' + precision + '))) as count from "' + table + '"'

  // apply any filters to the sql
  if (options.whereFilter) {
    countSql += options.whereFilter
  }

  if (options.geomFilter) {
    countSql += ((options.whereFilter) ? ' AND ' : ' WHERE ') + options.geomFilter
  }

  Geohash.query(countSql, function (err, res) {
    if (err) return callback(err, null)
    callback(null, res.rows[0].count)
  })
}

module.exports = Geohash
