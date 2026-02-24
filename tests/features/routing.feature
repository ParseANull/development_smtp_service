Feature: Routing and Filtering Configuration
  As a developer
  I want to configure routing and filtering rules
  So that emails are directed to appropriate destinations based on recipient patterns

  Background:
    Given an empty message store and a running web app with routing

  Scenario: Reading the default routing configuration
    When I GET "/api/routing"
    Then the response status should be 200
    And the routing destinations should include "memory"
    And the filter mode should be "none"

  Scenario: Updating the routing configuration
    When I PUT "/api/routing" with destinations "memory,smtp" and filter mode "blacklist" and patterns "blocked@.*"
    Then the response status should be 200
    And the routing destinations should include "memory"
    And the routing destinations should include "smtp"
    And the filter mode should be "blacklist"

  Scenario: Testing routing for a non-blacklisted recipient
    Given the routing is configured with filter mode "blacklist" and patterns "blocked@.*" and destinations "memory,smtp"
    When I POST "/api/routing/test" with recipient "allowed@example.com"
    Then the response status should be 200
    And the routing test result should not be storage only
    And the smtp destination should be active

  Scenario: Testing routing for a blacklisted recipient
    Given the routing is configured with filter mode "blacklist" and patterns "blocked@.*" and destinations "memory,smtp"
    When I POST "/api/routing/test" with recipient "blocked@example.com"
    Then the response status should be 200
    And the routing test result should be storage only
    And the smtp destination should not be active

  Scenario: Testing routing for a whitelisted recipient
    Given the routing is configured with filter mode "whitelist" and patterns "vip@.*" and destinations "memory,smtp"
    When I POST "/api/routing/test" with recipient "vip@example.com"
    Then the response status should be 200
    And the routing test result should not be storage only
    And the smtp destination should be active

  Scenario: Testing routing for a non-whitelisted recipient
    Given the routing is configured with filter mode "whitelist" and patterns "vip@.*" and destinations "memory,smtp"
    When I POST "/api/routing/test" with recipient "regular@example.com"
    Then the response status should be 200
    And the routing test result should be storage only

  Scenario: Rejecting an invalid routing configuration
    When I PUT "/api/routing" with an invalid destination type "ftp"
    Then the response status should be 400
    And the response body should contain "Unknown destination type"

  Scenario: Requiring a recipient for the routing test
    When I POST "/api/routing/test" without a recipient
    Then the response status should be 400
