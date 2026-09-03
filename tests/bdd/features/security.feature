Feature: Runtime security and privacy invariants
  Scenario: Loopback binding and authentication token verification
    Given an active router bridge server
    When a request is made with an invalid token
    Then the bridge server rejects the call
    And the bridge listens exclusively on 127.0.0.1
    And no secrets or prompt text are written to logs or state
