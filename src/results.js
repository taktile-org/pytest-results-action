const fs = require("fs").promises;

const gha = require("@actions/core");
const github = require("@actions/github");

const { zip, prettyDuration } = require("./utils");

module.exports = { postResults, extractResults, addResults, addSummary, getResultTypesFromDisplayOptions, renderShieldsSummary };

// FIXME: refactor
const resultTypes = [
  "passed",
  "skipped",
  "xfailed",
  "failed",
  "xpassed",
  "error",
];
const resultTypesWithEmoji = zip(
  resultTypes,
  ["green", "yellow", "yellow", "red", "red", "red"].map(
    (color) => `:${color}_circle:`
  )
);

async function postResults(xmls, inputs) {
  const results = await extractResults(xmls);
  if (results.total_tests == 0) {
    return;
  }

  if (inputs.comment && inputs.githubToken) {
    await postOrUpdatePrComment(results, inputs);
  }

  addResults(results, inputs.title, inputs.summary, inputs.displayOptions);
  await gha.summary.write();
}

async function extractResults(xmls) {
  const results = {
    total_time: 0.0,
    total_tests: 0,
    // FIXME: incorporate from above
    passed: [],
    failed: [],
    skipped: [],
    xfailed: [],
    xpassed: [],
    error: [],
  };

  for await (const xml of xmls) {
    var testSuites = xml.testsuites && xml.testsuites.testsuite;
    if (!testSuites) continue;
    testSuites = Array.isArray(testSuites) ? testSuites : [testSuites];

    for (var testSuite of testSuites) {
      if (!testSuite) continue;
      if (Object.hasOwn(testSuite, "@_time") && testSuite["@_time"] !== undefined) {
        results.total_time += parseFloat(testSuite["@_time"]);
      }

      var testCases = testSuite.testcase;
      if (!testCases) {
        continue;
      }
      testCases = testCases instanceof Array ? testCases : [testCases];
      for (const result of testCases) {
        var resultTypeArray;
        var msg;

        if (Object.hasOwn(result, "failure")) {
          var msg = result.failure["#text"];
          const parts = msg.split("[XPASS(strict)] ");
          if (parts.length == 2) {
            resultTypeArray = results.xpassed;
            msg = parts[1];
          } else {
            resultTypeArray = results.failed;
          }
        } else if (Object.hasOwn(result, "skipped")) {
          if (result.skipped["@_type"] == "pytest.xfail") {
            resultTypeArray = results.xfailed;
          } else {
            resultTypeArray = results.skipped;
          }
          msg = result.skipped["@_message"];
        } else if (Object.hasOwn(result, "error")) {
          resultTypeArray = results.error;
          // FIXME: do we need to integrate the message here?
          msg = result.error["#text"];
        } else {
          // This could also be an xpass when strict=False is set. Unfortunately, there is no way to differentiate here
          // See FIXME
          resultTypeArray = results.passed;
          msg = undefined;
        }

        resultTypeArray.push({
          id: result["@_classname"] + "." + result["@_name"],
          msg: msg,
        });
        results.total_tests += 1;
      }
    }
  }

  return results;
}

async function addResults(results, title, summary, displayOptions) {
  gha.summary.addHeading(title);

  if (summary) {
    addSummary(results);
  }

  for (resultType of getResultTypesFromDisplayOptions(displayOptions)) {
    const results_for_type = results[resultType];
    if (!results_for_type.length) {
      continue;
    }

    gha.summary.addHeading(resultType, 2);

    for (const result of results_for_type) {
      if (result.msg) {
        addDetailsWithCodeBlock(
          gha.summary,
          gha.summary.wrap("code", result.id),
          result.msg
        );
      } else {
        gha.summary.addRaw(`\n:heavy_check_mark: ${result.id}`, true);
      }
    }
  }
}

function addSummary(results) {
  gha.summary.addRaw(
    `Ran ${results.total_tests} tests in ${prettyDuration(results.total_time)}`,
    true
  );

  var rows = [["Result", "Amount"]];
  for (const [resultType, emoji] of resultTypesWithEmoji) {
    const abs_amount = results[resultType].length;
    const rel_amount = abs_amount / results.total_tests;
    rows.push([
      `${emoji} ${resultType}`,
      `${abs_amount} (${(rel_amount * 100).toFixed(1)}%)`,
    ]);
  }
  gha.summary.addTable(rows);
}

function getResultTypesFromDisplayOptions(displayOptions) {
  // 'N' resets the list of chars passed to the '-r' option of pytest. Thus, we only
  // care about anything after the last occurrence
  const displayChars = displayOptions.split("N").pop();

  console.log(displayChars);

  if (displayChars.toLowerCase().includes("a")) {
    return resultTypes;
  }

  var displayTypes = new Set();
  for (const [displayChar, displayType] of [
    ["f", "failed"],
    ["E", "error"],
    ["s", "skipped"],
    ["x", "xfailed"],
    ["X", "xpassed"],
    ["p", "passed"],
    ["P", "passed"],
  ]) {
    if (displayOptions.includes(displayChar)) {
      displayTypes.add(displayType);
    }
  }

  return [...displayTypes];
}

function addDetailsWithCodeBlock(summary, label, code) {
  return summary.addDetails(
    label,
    "\n\n" + summary.wrap("pre", summary.wrap("code", code))
  );
}

// Add this helper to render shields summary
function renderShieldsSummary(results, context) {
  // Extract info from context
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const runId = context.runId;
  const commit = context.sha;
  // GitHub Actions run summary URL
  const summaryUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;

  // Test counts
  const total = results.total_tests;
  const failed = results.failed.length;
  const error = results.error.length;
  const skipped = results.skipped.length;
  const xfailed = results.xfailed.length;
  const xpassed = results.xpassed.length;

  // Shields - only show if count > 0
  const shields = [
    '',
    ...(failed > 0  ? [`&ensp; [![Static Badge](https://raster.shields.io/badge/${failed}-failed-crimson)](${summaryUrl})`] : []),
    ...(error > 0   ? [`&ensp; [![Static Badge](https://raster.shields.io/badge/${error}-error-red)](${summaryUrl})`] : []),
    ...(skipped > 0 ? [`&ensp; [![Static Badge](https://raster.shields.io/badge/${skipped}-skipped-yellow)](${summaryUrl})`] : []),
    ...(xfailed > 0 ? [`&ensp; [![Static Badge](https://raster.shields.io/badge/${xfailed}-xfailed-orange)](${summaryUrl})`] : []),
    ...(xpassed > 0 ? [`&ensp; [![Static Badge](https://raster.shields.io/badge/${xpassed}-xpassed-red)](${summaryUrl})`] : [])
  ].join(' ');

  // Sub-links
  const subLinks = `<sub>\n\n[View Full Report ↗︎](${summaryUrl})\n\n</sub>`;

  // Add failed/error tests as text below shields
  let failedErrorText = '';
  if (failed > 0 || error > 0) {
    failedErrorText = '\n\n**Failed/Error Tests:**\n';
    if (failed > 0) {
      failedErrorText += `\n**Failed (${failed}):**\n`;
      results.failed.forEach(result => {
        failedErrorText += `\n<details>\n<summary>\n<strong>${result.msg}:</strong>\n</summary>\n<pre>\n<code>${result.id}</code>\n</pre>\n</details>\n`;
      });
    }
    if (error > 0) {
      failedErrorText += `\n**Error (${error}):**\n`;
      results.error.forEach(result => {
        failedErrorText += `\n<details>\n<summary>\n<strong>${result.msg}:</strong>\n</summary>\n<pre>\n<code>${result.id}</code>\n</pre>\n</details>\n`;
      });
    }
  }

  return `<!-- pytest-results-action -->\n\n${shields}\n\n${failedErrorText}\n\n${subLinks}\n`;
}

async function postOrUpdatePrComment(results, inputs) {
  const token = inputs.githubToken;
  const octokit = github.getOctokit(token);
  const context = github.context;
  const prNumber = context.payload.pull_request ? context.payload.pull_request.number : (context.payload.issue ? context.payload.issue.number : null);
  if (!prNumber) {
    gha.warning("No pull request context found. Skipping PR comment.");
    return;
  }
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const runId = context.runId;
  const jobName = context.job || (context.workflow ? `${context.workflow}` : "");
  const sectionId = `${runId}${jobName ? `-${jobName}` : ''}`;
  const sectionStart = `<!-- pytest-results-action run-id:${sectionId} -->`;
  const sectionEnd = `<!-- /pytest-results-action run-id:${sectionId} -->`;
  const marker = '<!-- pytest-results-action -->';

  const shouldPost = results.failed.length > 0 || results.error.length > 0 || results.skipped.length > 0 || results.xfailed.length > 0 || results.xpassed.length > 0;
  if (!shouldPost || false) {
    console.log("No tests failed, error, skipped, xfailed, or xpassed. Skipping PR comment.");
    return;
  }

  const sectionBody = `${sectionStart}\n#### ${inputs.title} \n ${renderShieldsSummary(results, context)}\n${sectionEnd}`;

  // Find existing comment
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });
  const existing = comments.find(c => c.body && c.body.startsWith(marker));

  if (existing) {
    let body = existing.body;
    // Remove all whitespace at the end for clean appending
    body = body.replace(/\s+$/, '');
    
    // Check if this run-id already exists in the comment
    if (!body.includes(sectionId) && body.includes(runId)) {
      // Append new section for this run/job after a line separator
      body = body + '\n\n---\n\n' + sectionBody;
    } else if (body.includes(sectionId)) {
      // Replace the section for this run/job
      body = body.replace(
        new RegExp(`<!-- pytest-results-action run-id:${sectionId} -->[\s\S]*?<!-- \/pytest-results-action run-id:${sectionId} -->`),
        sectionBody
      );
    }
    else {
      body = marker + '\n' + sectionBody;
    }
    
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    // New comment
    const body = marker + '\n' + sectionBody;
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  }
}
