var json = {
  title: "Employee Onboarding",
  description: "Select a role to see role-specific questions appear dynamically.",
  widthMode: "static",
  showQuestionNumbers: false,
  showPreviewBeforeComplete: true,
  pages: [
    {
      name: "basicInfo",
      elements: [
        { type: "text", name: "fullName", title: "Full Name", isRequired: true },
        { type: "text", name: "email", title: "Email", inputType: "email", isRequired: true },
        {
          type: "radiogroup",
          name: "role",
          title: "Select your role",
          isRequired: true,
          choices: [
            { value: "admin", text: "Administrator" },
            { value: "manager", text: "Manager" },
            { value: "developer", text: "Developer" },
            { value: "support", text: "Support Agent" }
          ]
        }
      ]
    },
    {
      name: "adminDetails",
      visibleIf: "{role} = 'admin'",
      elements: [
        {
          type: "checkbox",
          name: "adminPermissions",
          title: "Which system permissions do you need?",
          choices: ["User Management", "Billing", "Security Settings", "Audit Logs"]
        },
        { type: "boolean", name: "adminMfa", title: "Enable multi-factor authentication?", defaultValue: true }
      ]
    },
    {
      name: "managerDetails",
      visibleIf: "{role} = 'manager'",
      elements: [
        { type: "text", name: "teamSize", title: "How many people are on your team?", inputType: "number" },
        {
          type: "dropdown",
          name: "department",
          title: "Which department do you manage?",
          choices: ["Sales", "Engineering", "Marketing", "Operations"]
        }
      ]
    },
    {
      name: "developerDetails",
      visibleIf: "{role} = 'developer'",
      elements: [
        {
          type: "tagbox",
          name: "techStack",
          title: "Select your tech stack",
          choices: ["JavaScript", "TypeScript", "Python", "C#", "Java", "Go"]
        },
        { type: "comment", name: "githubProfile", title: "GitHub profile / portfolio link" }
      ]
    },
    {
      name: "supportDetails",
      visibleIf: "{role} = 'support'",
      elements: [
        {
          type: "rating",
          name: "supportExperience",
          title: "Rate your customer support experience (years)",
          rateMax: 10
        },
        {
          type: "checkbox",
          name: "supportChannels",
          title: "Which support channels have you worked with?",
          choices: ["Email", "Live Chat", "Phone", "Social Media"]
        }
      ]
    }
  ]
};

window.survey = new Survey.Model(json);
survey.onComplete.add(function (result) {
  document.querySelector("#surveyResultElement").innerHTML =
        "result: " + JSON.stringify(result.data);
});


window.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("surveyElement");
  const shadowRoot = container.attachShadow({ mode: 'open' });
  const rootElement = document.createElement("div");
  rootElement.classList.add("root-fixed")
  const styles = document.createElement("style");
  styles.textContent = `
    *,
    ::after,
    ::before {
        box-sizing: border-box;
    }

    .root-fixed {
      position: fixed;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
    }
  `;
  
  shadowRoot.appendChild(styles);
  const surveyLink = document.createElement('link');
  surveyLink.setAttribute('rel', 'stylesheet');
  surveyLink.setAttribute('href', './node_modules/survey-core/survey-core.css');
  shadowRoot.appendChild(surveyLink);
  shadowRoot.appendChild(rootElement);
  SurveyUI.renderSurvey(survey, rootElement);
});

