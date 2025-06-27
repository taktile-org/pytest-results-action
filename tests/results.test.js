const {
  extractResults,
  addSummary,
  getResultTypesFromDisplayOptions,
  renderShieldsSummary,
} = require('../src/results');
const fs = require('fs').promises;
const { XMLParser } = require('fast-xml-parser');

// Mock gha.summary for addSummary
jest.mock('@actions/core', () => ({
  summary: {
    addRaw: jest.fn().mockReturnThis(),
    addTable: jest.fn().mockReturnThis(),
    addHeading: jest.fn().mockReturnThis(),
    addDetails: jest.fn().mockReturnThis(),
    wrap: (tag, content) => `<${tag}>${content}</${tag}>`,
    write: jest.fn(),
  },
  warning: jest.fn(),
}));

describe('extractResults', () => {
  it('parses a simple passing test', async () => {
    const xmls = [
      {
        testsuites: {
          testsuite: {
            '@_time': '1.23',
            testcase: {
              '@_classname': 'a.b',
              '@_name': 'test_pass',
            },
          },
        },
      },
    ];
    const results = await extractResults(xmls);
    expect(results.passed).toHaveLength(1);
    expect(results.failed).toHaveLength(0);
    expect(results.total_tests).toBe(1);
    expect(results.total_time).toBeCloseTo(1.23);
  });

  it('parses failed, skipped, xfailed, xpassed, and error', async () => {
    const xmls = [
      {
        testsuites: {
          testsuite: {
            '@_time': '2.0',
            testcase: [
              {
                '@_classname': 'a.b',
                '@_name': 'fail',
                failure: { '#text': 'fail msg' },
              },
              {
                '@_classname': 'a.b',
                '@_name': 'xpass',
                failure: { '#text': '[XPASS(strict)] xpass msg' },
              },
              {
                '@_classname': 'a.b',
                '@_name': 'skip',
                skipped: { '@_type': 'pytest.skip', '@_message': 'skip msg' },
              },
              {
                '@_classname': 'a.b',
                '@_name': 'xfailed',
                skipped: { '@_type': 'pytest.xfail', '@_message': 'xfail msg' },
              },
              {
                '@_classname': 'a.b',
                '@_name': 'error',
                error: { '#text': 'error msg' },
              },
            ],
          },
        },
      },
    ];
    const results = await extractResults(xmls);
    expect(results.failed).toHaveLength(1);
    expect(results.xpassed).toHaveLength(1);
    expect(results.skipped).toHaveLength(1);
    expect(results.xfailed).toHaveLength(1);
    expect(results.error).toHaveLength(1);
    expect(results.total_tests).toBe(5);
    expect(results.total_time).toBeCloseTo(2.0);
  });
});

describe('getResultTypesFromDisplayOptions', () => {
  it('returns all types for "a"', () => {
    expect(getResultTypesFromDisplayOptions('a')).toEqual([
      'passed',
      'skipped',
      'xfailed',
      'failed',
      'xpassed',
      'error',
    ]);
  });
  it('returns failed and error for "fE"', () => {
    expect(getResultTypesFromDisplayOptions('fE')).toEqual(
      expect.arrayContaining(['failed', 'error'])
    );
  });
});

describe('addSummary', () => {
  it('calls summary methods with correct data', () => {
    const gha = require('@actions/core');
    const results = {
      total_tests: 2,
      total_time: 3.5,
      passed: [{}, {}],
      failed: [],
      skipped: [],
      xfailed: [],
      xpassed: [],
      error: [],
    };
    addSummary(results);
    expect(gha.summary.addRaw).toHaveBeenCalledWith(
      expect.stringContaining('Ran 2 tests'),
      true
    );
    expect(gha.summary.addTable).toHaveBeenCalled();
  });
});

describe('renderShieldsSummary', () => {
  it('renders shields and failed/error details', () => {
    const results = {
      total_tests: 3,
      failed: [{ id: 'a.b.test_fail', msg: 'fail msg' }],
      error: [{ id: 'a.b.test_error', msg: 'error msg' }],
      skipped: [],
      xfailed: [],
      xpassed: [],
    };
    const context = {
      repo: { owner: 'me', repo: 'repo' },
      runId: 123,
      sha: 'abc',
    };
    const summary = renderShieldsSummary(results, context);
    expect(summary).toContain('failed-crimson');
    expect(summary).toContain('error-red');
    expect(summary).toContain('fail msg');
    expect(summary).toContain('error msg');
    expect(summary).toContain('View Full Report');
  });
});

describe('integration: extractResults with real XML', () => {
  it('parses the test-results-integration.xml file', async () => {
    const xmlString = await fs.readFile(
      require('path').join(__dirname, 'test-results-integration.xml'),
      'utf-8'
    );
    const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });
    const parsed = parser.parse(xmlString);
    const results = await extractResults([parsed]);
    expect(results.failed.length).toBe(1);
    expect(results.total_tests).toBe(1);
    expect(results.failed[0].id).toContain('tests.integration.test_integration.test_dry_run');
    expect(results.failed[0].msg).toContain('github.GithubException.UnknownObjectException');
  });
}); 