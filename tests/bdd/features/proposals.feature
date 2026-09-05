Feature: SkillOpt proposal generation and management
  Scenario: Five new completed sessions trigger worker batch
    Given an isolated project with baseline initialized
    When 5 new valid OMP sessions are completed and recorded
    Then the proposal queue has 5 pending sessions
    And proposal scheduling succeeds for the project batch

  Scenario: Never re-analyze processed or failed sessions
    Given an isolated project with 5 completed sessions
    When an outcome of "analyzed" or "failed" is recorded for the sessions
    Then the proposal queue has 0 pending sessions
    And no subsequent run will re-select those sessions

  Scenario: Managed and per-skill proposals update statusline counter
    Given an isolated project staging directory
    When a valid accepted manifest with managed and fanout proposals is staged
    Then the proposals statusline displays "proposals: 2"
    And exactly one notification is emitted for each new proposal

  Scenario: Manual adoption and discard update proposal lifecycle
    Given an isolated project with a staged proposal
    When the proposal is adopted via the CLI or discarded by the user
    Then the proposal is removed from pending proposals
    And the proposals statusline is cleared

  Scenario: Worker failure or missing session file does not block OMP
    Given an invalid or corrupt session file on shutdown
    When session shutdown is handled by the extension
    Then the extension logs the rejection fail-open without throwing
