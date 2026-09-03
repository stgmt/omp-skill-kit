Feature: Upstream mega-tron dashboard
  Scenario: Dashboard loopback launch, status check, and graceful shutdown
    Given an isolated home directory with active runtime
    When the dashboard is launched
    Then it binds to loopback port and responds to overview API
    And dashboard.json is saved atomically with runtime hash and PID
    And stopping the dashboard cleanly terminates the process

  Scenario: Dashboard queues during installation and opens after ready
    Given an isolated home directory with an active installation
    When the dashboard command is executed
    Then the dashboard is queued to open automatically without requiring manual setup
    When the installation transitions to ready
    Then the queued dashboard is opened exactly once

  Scenario: Dashboard queue clears when installation degrades
    Given an isolated home directory with an active installation
    When the dashboard command is executed
    When the installation transitions to degraded
    Then any pending dashboard queue is cleared


  Scenario: Windows dashboard browser opener avoids a console shell
    Given a dashboard URL for the Windows browser opener
    When the browser opener command is resolved for Windows
    Then the opener executable is explorer.exe
    And the opener command does not contain a console shell
