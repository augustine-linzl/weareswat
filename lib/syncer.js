(function syncer() {

  var JiraApi = require('jira').JiraApi;
  var GithubApi = require('github');
  var _ = require('underscore');
  var async = require('async');
  var jiraExtension = require('./jira-extension.js');
  var context = {};

  var configApis = function configApis(config) {
    var apis = { jira: {} };
    apis.jira.default = new JiraApi(
      config.jira.protocol,
      config.jira.host,
      config.jira.port,
      config.jira.user,
      config.jira.password,
      config.jira.defaultApi.version
    );
    apis.jira.greenhopper = new JiraApi(
      config.jira.protocol,
      config.jira.host,
      config.jira.port,
      config.jira.user,
      config.jira.password,
      config.jira.greenhopper.version
    );
    jiraExtension.extend(apis.jira.greenhopper);

    apis.github = new GithubApi({version: "3.0.0"});
    apis.github.authenticate(config.github.auth);
    return apis;
  };
  
  var getCurrentSprint = function getCurrentSprint(callback) {
    context.api.jira.greenhopper.findRapidView(context.config.jira.project, function(error, rapidView) {
      context.rapidView = rapidView;
      context.api.jira.greenhopper.getLastSprintForRapidView(rapidView.id, function(error, sprint) {
        context.sprint = sprint;
        callback(sprint);
      });
    });
  };

  var checkIfMilestoneExists = function checkIfMilestoneExists(sprint, callback) {
    var msg = _.extend(context.config.github, {state:'open'});
    context.api.github.issues.getAllMilestones(msg, function(error, milestones) {
      var milestone = _.find(milestones, function(milestone) { return milestone.title == sprint.name;});
      if( milestone ) {
        context.milestone = milestone;
        console.log(' - Exists');
        callback(error, true);
      } else {
        console.log(' - Not found');
        callback(error, false);
      }
    });
  };

  var createMilestone = function createMilestone(sprint, callback) {
    var createMilestoneMsg = _.extend(context.config.github, {title: sprint.name, state:'open'});
    context.api.github.issues.createMilestone(createMilestoneMsg, function(error, result) {
      console.log(' - New milestone created');
      context.milestone = result;
      callback(null);
    });
  };

  var buildMilestone = function buildMilestone(callback) {
    getCurrentSprint(function operateSprint(sprint) {
      console.log('Sprint: ' + sprint.name);
      checkIfMilestoneExists(sprint, function milestoneProbe(error, exists) {
        if(exists) {
          // update?
          callback(null);
        } else {
          createMilestone(sprint, callback);
        }
      });
    });
  };

  var getSprintIssues = function getSprintIssues(callback) {
    var filter = _.extend(context.config.github, {
     milestone: context.milestone.number,
     per_page: 100
    });
    context.api.github.issues.repoIssues(filter, function saveGhIssues(error, issues) {
      context.ghIssues = issues;
      console.log('Got ' + issues.length + ' issues open from milestone on GH' );
      callback(error, issues);
    });
  };

  var getClosedSprintIssues = function getClosedSprintIssues(callback) {
    var filter = _.extend(context.config.github, {
     milestone: context.milestone.number,
     state: 'closed',
     per_page: 100
    });
    context.api.github.issues.repoIssues(filter, function saveGhIssues(error, issues) {
      context.ghIssues = issues;
      console.log('Got ' + issues.length + ' issues closed from milestone on GH' );
      callback(error, issues);
    });
  };

  var getGhIssueFor = function getGhIssue(jiraIssue) {
    return _.find(context.ghIssues, function(current) {
      return current.title.match("^" + jiraIssue.key);
    });
  };

  var getGhUserFor = function getGhUserFor(jiraUser) {
    var ghuser = context.config.userMapping[jiraUser];
    if(!ghuser) {
      throw new Error("Can't find ghuser for jiraUser:" + jiraUser);
    }
    return ghuser;
  };

  var createGhIssue = function createGhIssue(jiraIssue, callback) {
    console.log('\t-Created new');
    var args = _.extend(context.config.github, {
      assignee: getGhUserFor(jiraIssue.assignee),
      title: jiraIssue.key + ': ' + jiraIssue.summary,
      milestone: context.milestone.number,
      labels: [jiraIssue.typeName, jiraIssue.priorityName]
    });
    context.api.github.issues.create(args, callback);
  };

  var jiraTypes = [
    'Task', 'Bug',
    'Technical-Task', 'Design-Task',
    'Technical Task', 'Design Task'
  ];

  var validIssueTypeForImport = function validIssueTypeForImport(typeName) {
    var match = _.find(jiraTypes, function finder(jiraType) {return jiraType === typeName; });
    return match !== undefined;
  };

  var generateGithubIssue = function generateGithubIssue(issues, callback, masterCallback) {
    var issue = issues.pop();
    console.log(' - ' + issue.typeName + ':' + issue.key );

    if(validIssueTypeForImport(issue.typeName)) {
      var ghissue = getGhIssueFor(issue);
      if(ghissue) {
        console.log('\t- Already exists');
        generateGithubIssues(issues, null, masterCallback);
      } else {
        createGhIssue(issue, function(error) {
          generateGithubIssues(issues, null, masterCallback);
        });
      }
    } else {
      console.log('\t- Ignored');
      generateGithubIssues(issues, null, masterCallback);
    }
  };

  var generateGithubIssues = function generateGithubIssues(issues, callback, masterCallback) {
    if(_.isEmpty(issues) ) {
      masterCallback(null);
    } else {
      generateGithubIssue(issues, generateGithubIssues, masterCallback);
    }
  };

  var addJiraSubtasks = function addJiraSubtasks(issue, callback) {
    context.api.jira.default.findIssue(issue.key, function getIssue(error, completeIssue) {
      _.each(completeIssue.fields.subtasks, function(subtask) {
        subtask.typeName = subtask.fields.issuetype.name;
        subtask.summary = subtask.fields.summary;
        subtask.priorityName = subtask.fields.priority.name;
        subtask.assignee = issue.assignee;
      });
      context.subIssues = _.union(context.subIssues, completeIssue.fields.subtasks);
      callback(error, completeIssue);
    });
  };

  var createJiraTasksOnGithub = function createJiraTasksOnGithub(callback) {
    context.api.jira.greenhopper.getSprintIssues(context.rapidView.id, context.sprint.id, function(error, result) {
      var masterIssues = _.union(result.contents.completedIssues, result.contents.incompletedIssues);
      context.subIssues = [];

      async.each(masterIssues, addJiraSubtasks, function completed(err) {
        context.jiraOpenIssues = _.union(result.contents.incompletedIssues, context.subIssues);
        var issues = _.union(result.contents.incompletedIssues, context.subIssues); // clone 
        console.log('Sprint issues: ' + context.jiraOpenIssues.length);
        generateGithubIssues(issues, null, callback);
      });
    });
  };

  var errorLog = function(error) {
    if(error) {
      console.log(error);
    }
  };

  var getJiraIssueFor = function getJiraIssue(ghIssue) {
    return _.find(context.jiraOpenIssues, function iter(jiraIssue) {
      return ghIssue.title.match('^' + jiraIssue.key + ':');
    });
  };

  var closeJiraTask = function closeJiraTask(ghIssue, callback) {
    console.log(' - ' + ghIssue.title + ' closed!');
    var jiraIssue = getJiraIssueFor(ghIssue);
    if(!jiraIssue) {
      // already closed
      return;
    }
    var msg = {
      "transition": {
        "id": "5"
      }
    };
    context.api.jira.default.transitionIssue(jiraIssue.key, msg, function(error) {
      errorLog(error);
      callback(null);
    });
  };

  var closeJiraTasks = function closeJiraTasks(callback) {
    getClosedSprintIssues(function closed(error, issues) {
      context.ghClosedIssues = issues;
      async.each(context.ghClosedIssues, closeJiraTask, callback);
    });
  };

  exports.process = function process(config) {
    context.config = config;
    context.api = configApis(config);
    async.series([
      buildMilestone,
      getSprintIssues,
      createJiraTasksOnGithub,
      closeJiraTasks
    ], errorLog);
  };

})();
