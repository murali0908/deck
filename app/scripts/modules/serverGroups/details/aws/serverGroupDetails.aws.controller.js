'use strict';
/* jshint camelcase:false */


angular.module('spinnaker.serverGroup.details.aws.controller', [
  'ui.bootstrap',
  'spinnaker.confirmationModal.service',
  'spinnaker.serverGroup.write.service',
  'spinnaker.utils.lodash',
  'spinnaker.serverGroup.details.aws.autoscaling.process',
  'spinnaker.serverGroup.read.service',
  'spinnaker.aws.serverGroupCommandBuilder.service',
  'spinnaker.executionFilter.service',
  'spinnaker.vpc.tag.directive',
  'spinnaker.migrator.directive',
])
  .controller('awsServerGroupDetailsCtrl', function ($scope, $state, $templateCache, $compile, application, serverGroup,
                                                     serverGroupReader, awsServerGroupCommandBuilder, $modal, confirmationModalService, _, serverGroupWriter,
                                                     subnetReader, autoScalingProcessService, executionFilterService) {

    $scope.state = {
      loading: true
    };

    function applyAutoScalingProcesses() {
      $scope.autoScalingProcesses = [];
      if (!$scope.serverGroup.asg || !$scope.serverGroup.asg.suspendedProcesses) {
        return;
      }
      var disabled = _.pluck($scope.serverGroup.asg.suspendedProcesses, 'processName');
      var allProcesses = autoScalingProcessService.listProcesses();
      allProcesses.forEach(function(process) {
        $scope.autoScalingProcesses.push({
          name: process.name,
          enabled: disabled.indexOf(process.name) === -1,
          description: process.description,
        });
      });
    }

    function extractServerGroupSummary() {
      var summary = _.find(application.serverGroups, function (toCheck) {
        return toCheck.name === serverGroup.name && toCheck.account === serverGroup.accountId && toCheck.region === serverGroup.region;
      });
      if (!summary) {
        application.loadBalancers.some(function (loadBalancer) {
          if (loadBalancer.account === serverGroup.accountId && loadBalancer.region === serverGroup.region) {
            return loadBalancer.serverGroups.some(function (possibleServerGroup) {
              if (possibleServerGroup.name === serverGroup.name) {
                summary = possibleServerGroup;
                return true;
              }
            });
          }
        });
      }
      return summary;
    }

    function retrieveServerGroup() {
      var summary = extractServerGroupSummary();
      serverGroupReader.getServerGroup(application.name, serverGroup.accountId, serverGroup.region, serverGroup.name).then(function(details) {
        cancelLoader();

        var restangularlessDetails = details.plain();
        angular.extend(restangularlessDetails, summary);

        $scope.serverGroup = restangularlessDetails;
        $scope.runningExecutions = function() {
          return executionFilterService.filterRunningExecutions($scope.serverGroup.executions);
        };

        if (!_.isEmpty($scope.serverGroup)) {

          $scope.image = details.image ? details.image : undefined;

          var vpc = $scope.serverGroup.asg ? $scope.serverGroup.asg.vpczoneIdentifier : '';

          if (vpc !== '') {
            var subnetId = vpc.split(',')[0];
            subnetReader.listSubnets().then(function(subnets) {
              var subnet = _(subnets).find({'id': subnetId});
              $scope.serverGroup.subnetType = subnet.purpose;
            });
          }

          if (details.image && details.image.description) {
            var tags = details.image.description.split(', ');
            tags.forEach(function(tag) {
              var keyVal = tag.split('=');
              if (keyVal.length === 2 && keyVal[0] === 'ancestor_name') {
                details.image.baseImage = keyVal[1];
              }
            });
          }

          if (details.launchConfig && details.launchConfig.securityGroups) {
            $scope.securityGroups = _(details.launchConfig.securityGroups).map(function(id) {
              return _.find(application.securityGroups, { 'accountName': serverGroup.accountId, 'region': serverGroup.region, 'id': id }) ||
                _.find(application.securityGroups, { 'accountName': serverGroup.accountId, 'region': serverGroup.region, 'name': id });
            }).compact().value();
          }

          applyAutoScalingProcesses();

        } else {
          $state.go('^');
        }
      });
    }

    function cancelLoader() {
      $scope.state.loading = false;
    }

    retrieveServerGroup();

    application.registerAutoRefreshHandler(retrieveServerGroup, $scope);

    this.destroyServerGroup = function destroyServerGroup() {
      var serverGroup = $scope.serverGroup;

      var taskMonitor = {
        application: application,
        title: 'Destroying ' + serverGroup.name,
        forceRefreshMessage: 'Refreshing application...',
        forceRefreshEnabled: true,
        katoPhaseToMonitor: 'DESTROY_ASG'
      };

      var submitMethod = function () {
        return serverGroupWriter.destroyServerGroup(serverGroup, application);
      };

      var stateParams = {
        name: serverGroup.name,
        accountId: serverGroup.account,
        region: serverGroup.region
      };


      confirmationModalService.confirm({
        header: 'Really destroy ' + serverGroup.name + '?',
        buttonText: 'Destroy ' + serverGroup.name,
        destructive: true,
        account: serverGroup.account,
        provider: 'aws',
        taskMonitorConfig: taskMonitor,
        submitMethod: submitMethod,
        body: this.getBodyTemplate(serverGroup, application),
        onTaskComplete: function() {
          if ($state.includes('**.serverGroup', stateParams)) {
            $state.go('^');
          }
        },
        onApplicationRefresh: function() {
          if ($state.includes('**.serverGroup', stateParams)) {
            $state.go('^');
          }
        }
      });
    };

    this.getBodyTemplate = function(serverGroup, application) {
      if(this.isLastServerGroupInRegion(serverGroup, application)){
        var template = $templateCache.get('scripts/modules/serverGroups/details/aws/deleteLastServerGroupWarning.html');
        $scope.deletingServerGroup = serverGroup;
        return $compile(template)($scope);
      }
    };

    this.isLastServerGroupInRegion = function (serverGroup, application ) {
      try {
        var cluster = _.find(application.clusters, {name: serverGroup.cluster, account:serverGroup.account});
        return _.filter(cluster.serverGroups, {region: serverGroup.region}).length === 1;
      } catch (error) {
        return false;
      }
    };

    this.disableServerGroup = function disableServerGroup() {
      var serverGroup = $scope.serverGroup;

      var taskMonitor = {
        application: application,
        title: 'Disabling ' + serverGroup.name
      };

      var submitMethod = function () {
        return serverGroupWriter.disableServerGroup(serverGroup, application);
      };

      confirmationModalService.confirm({
        header: 'Really disable ' + serverGroup.name + '?',
        buttonText: 'Disable ' + serverGroup.name,
        destructive: true,
        account: serverGroup.account,
        provider: 'aws',
        taskMonitorConfig: taskMonitor,
        submitMethod: submitMethod
      });

    };

    this.enableServerGroup = function enableServerGroup() {
      var serverGroup = $scope.serverGroup;

      var taskMonitor = {
        application: application,
        title: 'Enabling ' + serverGroup.name,
      };

      var submitMethod = function () {
        return serverGroupWriter.enableServerGroup(serverGroup, application);
      };

      confirmationModalService.confirm({
        header: 'Really enable ' + serverGroup.name + '?',
        buttonText: 'Enable ' + serverGroup.name,
        destructive: false,
        account: serverGroup.account,
        taskMonitorConfig: taskMonitor,
        submitMethod: submitMethod
      });

    };

    this.toggleScalingProcesses = function toggleScalingProcesses() {
      $modal.open({
        templateUrl: 'scripts/modules/serverGroups/details/aws/modifyScalingProcesses.html',
        controller: 'ModifyScalingProcessesCtrl as ctrl',
        resolve: {
          serverGroup: function() { return $scope.serverGroup; },
          application: function() { return application; },
          processes: function() { return $scope.autoScalingProcesses; },
        }
      });
    };

    this.resizeServerGroup = function resizeServerGroup() {
      $modal.open({
        templateUrl: 'scripts/modules/serverGroups/details/resizeServerGroup.html',
        controller: 'ResizeServerGroupCtrl as ctrl',
        resolve: {
          serverGroup: function() { return $scope.serverGroup; },
          application: function() { return application; }
        }
      });
    };

    this.cloneServerGroup = function cloneServerGroup(serverGroup) {
      $modal.open({
        templateUrl: 'scripts/modules/serverGroups/configure/' + serverGroup.type + '/wizard/serverGroupWizard.html',
        controller: serverGroup.type + 'CloneServerGroupCtrl as ctrl',
        resolve: {
          title: function() { return 'Clone ' + serverGroup.name; },
          application: function() { return application; },
          serverGroupCommand: function() { return awsServerGroupCommandBuilder.buildServerGroupCommandFromExisting(application, serverGroup); },
        }
      });
    };

    this.showScalingActivities = function showScalingActivities() {
      $scope.activities = [];
      $modal.open({
        templateUrl: 'scripts/modules/serverGroups/details/scalingActivities.html',
        controller: 'ScalingActivitiesCtrl as ctrl',
        resolve: {
          applicationName: function() { return application.name; },
          account: function() { return $scope.serverGroup.account; },
          clusterName: function() { return $scope.serverGroup.cluster; },
          serverGroup: function() { return $scope.serverGroup; }
        }
      });
    };

    this.showUserData = function showScalingActivities() {
      $scope.userData = window.atob($scope.serverGroup.launchConfig.userData);
      $modal.open({
        templateUrl: 'views/application/modal/serverGroup/userData.html',
        controller: 'CloseableModalCtrl',
        scope: $scope
      });
    };

    this.buildJenkinsLink = function() {
      if ($scope.serverGroup && $scope.serverGroup.buildInfo && $scope.serverGroup.buildInfo.jenkins) {
        var jenkins = $scope.serverGroup.buildInfo.jenkins;
        return jenkins.host + 'job/' + jenkins.name + '/' + jenkins.number;
      }
      return null;
    };

    this.truncateCommitHash = function() {
      if ($scope.serverGroup && $scope.serverGroup.buildInfo && $scope.serverGroup.buildInfo.commit) {
        return $scope.serverGroup.buildInfo.commit.substring(0, 8);
      }
      return null;
    };
  }
);
