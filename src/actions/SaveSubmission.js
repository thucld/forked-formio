'use strict';

const _ = require('lodash');
const async = require('async');
const {IsolateVM} = require('@formio/vm');
const util = require('../util/util');
const LOG_EVENT = 'Save Submission Action';

module.exports = function(router) {
  const Action = router.formio.Action;
  const debug = require('debug')('formio:action:saveSubmission');
  const hook = require('../util/hook')(router.formio);
  const ecode = router.formio.util.errorCodes;
  const logOutput = router.formio.log || debug;
  const log = (...args) => logOutput(LOG_EVENT, ...args);
  const config = router.formio.config;
  const SaveSubmissionActionVM = new IsolateVM({timeoutMs: config.vmTimeout});

  class SaveSubmission extends Action {
    static info(req, res, next) {
      next(null, {
        name: 'save',
        title: 'Save Submission',
        description: 'Saves the submission into the database.',
        priority: 10,
        defaults: {
          handler: ['before'],
          method: ['create', 'update']
        },
        access: {
          handler: false,
          method: false
        }
      });
    }

    static settingsForm(req, res, next) {
      next(null, [
        {
          type: 'resourcefields',
          key: 'resource',
          title: 'Save submission to',
          placeholder: 'This form',
          basePath: hook.alter('path', '/form', req),
          form: req.params.formId,
          required: false
        }
      ]);
    }

    /**
     * Resolve the default action.
     *
     * @param handler
     * @param method
     * @param req
     * @param res
     * @param next
     * @returns {*}
     */
    resolve(handler, method, req, res, next) {
      // Return if this is not a PUT or POST.
      if (req.skipSave || !req.body || (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH')) {
        return next();
      }

      // Make sure we do not skip the resource.
      req.skipResource = false;

      // If there are not any settings, then move along.
      if (!this.settings || !this.settings.resource) {
        return next();
      }

      // Keep track of the cache for this request.
      const cache = {};

      // Save data to a separate resource.
      const saveToResource = function(resource, body, done) {
        if (!body) {
          return done();
        }

        // Here we will clone the request, and then change the request body
        // and parameters to make it seem like a separate request to update
        // the child submissions.
        const childReq = util.createSubRequest(req);
        if (!childReq) {
          log(
            req,
            ecode.request.EREQRECUR,
            new Error(ecode.request.EREQRECUR),
            '#resolve'
          );
          return done(ecode.request.EREQRECUR);
        }

        // Don't recheck permissions against the new resource.
        childReq.permissionsChecked = true;
        childReq.noResponse = true;
        childReq.body = body;
        childReq.formId = childReq.params.formId = resource._id.toString();

        let url = '/form/:formId/submission';
        const method = req.method.toLowerCase();
        if (method === 'put') {
          if (body._id) {
            childReq.subId = childReq.params.submissionId = body._id;
            url += '/:submissionId';
          }
          else {
            log(
              req,
              ecode.resource.ENOIDP,
              new Error(ecode.resource.ENOIDP),
              '#resolve'
            );
            return done(ecode.resource.ENOIDP); // Return an error.
          }
        }

        childReq.url = url;
        childReq.method = method.toUpperCase();
        if (router.resourcejs.hasOwnProperty(url) && router.resourcejs[url].hasOwnProperty(method)) {
          router.resourcejs[url][method].call(this, childReq, res, done);
        }
        else {
          log(
            req,
            ecode.resource.ENOHANDLER,
            new Error(ecode.resource.ENOHANDLER),
            '#resolve',
            url,
            method
          );

          done(ecode.resource.ENOHANDLER);
        }
      }.bind(this);

      /**
       * Load a resource.
       * @type {function(this:SaveSubmission)}
       */
      const loadResource = async function(cache, then) {
        try {
          const resource = await router.formio.cache.loadForm(req, 'resource', this.settings.resource);
          cache.resource = resource;
          then();
        }
        catch (err) {
          log(req, ecode.cache.EFORMLOAD, err, '#resolve');
          return then(err);
        }
      }.bind(this);

      /**
       * Assign a resource to the request object for the next submission.
       *
       * @param then
       */
      const assignResource = function(then) {
        // Get the resource.
        const resource = (res.resource && res.resource.item) ? res.resource.item : cache.submission;

        // Assign the resource to this submission.
        if (this.settings.property) {
          req.body.data[this.settings.property] = resource;
        }

        // Save the reference in the external ids.
        if ((req.method === 'POST') && res.resource && res.resource.item) {
          // Save the external resource in the external ids.
          req.body.externalIds = req.body.externalIds || [];
          req.body.externalIds.push({
            type: 'resource',
            resource: this.settings.resource,
            id: res.resource.item._id.toString()
          });
        }

        then();
      }.bind(this);

      /**
       * Update a submission object with the latest data.
       *
       * @param submission
       * @param req
       * @returns {*}
       */
      const updateSubmission =  async function(submission) {
        submission = submission || {};
        submission.data = submission.data || {};

        // Iterate over all the available fields.
        _.each(this.settings.fields, function(field, key) {
          if (field === 'data') {
            _.set(submission.data, key, req.body.data);
          }
          else if (_.has(req.body.data, field)) {
            _.set(submission.data, key, _.get(req.body.data, field));
          }
        });

        if (this.settings.transform) {
          try {
            const newData = await SaveSubmissionActionVM.evaluate(
              `data=submission.data;\n${this.settings.transform}\ndata;`,
              {
                  submission: (res.resource && res.resource.item) ? res.resource.item : req.body,
                  data: submission.data,
              },
            );
            submission.data = newData;
            req.isTransformedData = true;
          }
          catch (err) {
            debug(`Error in submission transform: ${err.message || err}`);
          }
        }

        return submission;
      }.bind(this);

      /**
       * Load a submission.
       *
       * @param form
       * @param then
       */
      const loadSubmission = async function(cache, then) {
        const submission = {data: {}, roles: []};

        // For new submissions, just populate the empty submission.
        if (req.method !== 'PUT') {
          cache.submission = await updateSubmission(submission);
          return then();
        }

        // Move on if there is no id or form.
        if (!req.body._id || !req.body.form) {
          return then();
        }

        try {
          const currentSubmission = await router.formio.cache.loadSubmission(req, req.body.form, req.body._id);
          // Find the external submission.
          const external = _.find(currentSubmission.externalIds, {
            type: 'resource',
            resource: this.settings.resource
          });
          if (!external) {
            return then();
          }

          const submission = await router.formio.cache.loadSubmission(req, this.settings.resource, external.id);
          if (!submission) {
            return then();
          }
          cache.submission = await updateSubmission(submission);
          then();
        }
        catch (err) {
          log(req, ecode.submission.ESUBLOAD, err, '#resolve');
          return then(err);
        }
      }.bind(this);

      // Skip this resource.
      req.skipResource = true;
      async.series([
        async.apply(loadResource, cache),
        async.apply(loadSubmission, cache)
      ], function(err) {
        if (err) {
          log(req, err);
          return next(err);
        }

        if (!cache.submission) {
          return next();
        }

        async.series([
          async.apply(saveToResource, cache.resource, cache.submission),
          assignResource
        ], next);
      }.bind(this));
    }
  }

  // Return the SaveSubmission.
  return SaveSubmission;
};
