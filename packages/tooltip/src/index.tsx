/**
 * Welcome to @reach/tooltip!
 *
 * When the user's mouse or focus rests on an element, a non-interactive popup
 * is displayed near it.
 *
 * Quick definitions:
 *
 * - "on rest" or "rested on": describes when the element receives mouse hover
 *   after a short delay (and hopefully soon, touch longpress).
 *
 * - "activation": describes a mouse click, keyboard enter, or keyboard space.
 *
 * Only one tooltip can be visible at a time, so we use a global state chart to
 * describe the various states and transitions between states that are
 * possible. With all the timeouts involved with tooltips it's important to
 * "make impossible states impossible" with a state machine.
 *
 * It's also okay to use these module globals because you don't server render
 * tooltips. None of the state is changed outside of user events.
 *
 * There are a few features that are important to understand.
 *
 * 1. Tooltips don't show up until the user has rested on one, we don't
 *    want tooltips popupping up as you move your mouse around the page.
 *
 * 2. Once any tooltip becomes visible, other tooltips nearby should skip
 *    resting and display immediately.
 *
 * 3. Tooltips stick around for a little bit after blur/mouseleave.
 *
 * TODO: Research longpress tooltips on Android, iOS
 *       - Probably want to position it by default above, since your thumb is
 *         below and would cover it
 *       - I'm thinking after longpress, display the tooltip and cancel any
 *         click events. Then on touchend, so they can read it display the
 *         tooltip for a little while longer in case their hand was
 *         obstructing the tooltip.
 *
 * @see Docs     https://reach.tech/tooltip
 * @see Source   https://github.com/reach/reach-ui/tree/main/packages/tooltip
 * @see WAI-ARIA https://www.w3.org/TR/wai-aria-practices-1.2/#tooltip
 */

import * as React from "react";
import { useId } from "@reach/auto-id";
import {
  forwardRefWithAs,
  getOwnerDocument,
  getDocumentDimensions,
  makeId,
  useCheckStyles,
  useForkedRef,
  wrapEvent,
  warning,
} from "@reach/utils";
import { Portal } from "@reach/portal";
import { VisuallyHidden } from "@reach/visually-hidden";
import { useRect } from "@reach/rect";
import PropTypes from "prop-types";

const MOUSE_REST_TIMEOUT = 100;
const LEAVE_TIMEOUT = 500;

////////////////////////////////////////////////////////////////////////////////
// States

// Nothing goin' on
const IDLE = "IDLE";

// We're considering showing the tooltip, but we're gonna wait a sec
const FOCUSED = "FOCUSED";

// It's on!
const VISIBLE = "VISIBLE";

// Focus has left, but we want to keep it visible for a sec
const LEAVING_VISIBLE = "LEAVING_VISIBLE";

// The user clicked the tool, so we want to hide the thing, we can't just use
// IDLE because we need to ignore mousemove, etc.
const DISMISSED = "DISMISSED";

////////////////////////////////////////////////////////////////////////////////
// Events

const BLUR = "BLUR";
const FOCUS = "FOCUS";
const GLOBAL_MOUSE_MOVE = "GLOBAL_MOUSE_MOVE";
const MOUSE_DOWN = "MOUSE_DOWN";
const MOUSE_ENTER = "MOUSE_ENTER";
const MOUSE_LEAVE = "MOUSE_LEAVE";
const MOUSE_MOVE = "MOUSE_MOVE";
const REST = "REST";
const SELECT_WITH_KEYBOARD = "SELECT_WITH_KEYBOARD";
const TIME_COMPLETE = "TIME_COMPLETE";

const chart: StateChart = {
  initial: IDLE,
  states: {
    [IDLE]: {
      enter: clearContextId,
      on: {
        [MOUSE_ENTER]: FOCUSED,
        [FOCUS]: VISIBLE,
      },
    },
    [FOCUSED]: {
      enter: startRestTimer,
      leave: clearRestTimer,
      on: {
        [MOUSE_MOVE]: FOCUSED,
        [MOUSE_LEAVE]: IDLE,
        [MOUSE_DOWN]: DISMISSED,
        [BLUR]: IDLE,
        [REST]: VISIBLE,
      },
    },
    [VISIBLE]: {
      on: {
        [FOCUS]: FOCUSED,
        [MOUSE_ENTER]: FOCUSED,
        [MOUSE_LEAVE]: LEAVING_VISIBLE,
        [BLUR]: LEAVING_VISIBLE,
        [MOUSE_DOWN]: DISMISSED,
        [SELECT_WITH_KEYBOARD]: DISMISSED,
        [GLOBAL_MOUSE_MOVE]: LEAVING_VISIBLE,
      },
    },
    [LEAVING_VISIBLE]: {
      enter: startLeavingVisibleTimer,
      leave: () => {
        clearLeavingVisibleTimer();
        clearContextId();
      },
      on: {
        [MOUSE_ENTER]: VISIBLE,
        [FOCUS]: VISIBLE,
        [TIME_COMPLETE]: IDLE,
      },
    },
    [DISMISSED]: {
      leave: () => {
        // allows us to come on back later w/o entering something else first
        context.id = null;
      },
      on: {
        [MOUSE_LEAVE]: IDLE,
        [BLUR]: IDLE,
      },
    },
  },
};

/*
 * Chart context allows us to persist some data around, in Tooltip all we use
 * is the id of the current tooltip being interacted with.
 */
let context: StateContext = { id: null };
let state = chart.initial;

////////////////////////////////////////////////////////////////////////////////
// Subscriptions:
//
// We could require apps to render a <TooltipProvider> around the app and use
// React context to notify Tooltips of changes to our state machine, instead
// we manage subscriptions ourselves and simplify the Tooltip API.
//
// Maybe if default context could take a hook (instead of just a static value)
// that was rendered at the root for us, that'd be cool! But it doesn't.
let subscriptions: Function[] = [];

function subscribe(fn: Function) {
  subscriptions.push(fn);
  return () => {
    subscriptions.splice(subscriptions.indexOf(fn), 1);
  };
}

function notify() {
  subscriptions.forEach((fn) => fn(state, context));
}

////////////////////////////////////////////////////////////////////////////////
// Timeouts:

// Manages when the user "rests" on an element. Keeps the interface from being
// flashing tooltips all the time as the user moves the mouse around the screen.
let restTimeout: number;

function startRestTimer() {
  window.clearTimeout(restTimeout);
  restTimeout = window.setTimeout(() => transition(REST), MOUSE_REST_TIMEOUT);
}

function clearRestTimer() {
  window.clearTimeout(restTimeout);
}

// Manages the delay to hide the tooltip after rest leaves.
let leavingVisibleTimer: number;

function startLeavingVisibleTimer() {
  window.clearTimeout(leavingVisibleTimer);
  leavingVisibleTimer = window.setTimeout(
    () => transition(TIME_COMPLETE),
    LEAVE_TIMEOUT
  );
}

function clearLeavingVisibleTimer() {
  window.clearTimeout(leavingVisibleTimer);
}

// allows us to come on back later w/o entering something else first after the
// user leaves or dismisses
function clearContextId() {
  context.id = null;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * useTooltip
 *
 * @param params
 */
function useTooltip<T extends HTMLElement>({
  id: idProp,
  onMouseEnter,
  onMouseMove,
  onMouseLeave,
  onFocus,
  onBlur,
  onKeyDown,
  onMouseDown,
  ref: forwardedRef,
  DEBUG_STYLE,
}: {
  ref?: React.Ref<any>;
  DEBUG_STYLE?: boolean;
} & React.HTMLAttributes<T> = {}): [TriggerParams, TooltipParams, boolean] {
  let id = String(useId(idProp));

  let [isVisible, setIsVisible] = React.useState(
    DEBUG_STYLE
      ? true
      : id === null
      ? false
      : context.id === id && state === VISIBLE
  );

  // hopefully they always pass a ref if they ever pass one
  let ownRef = React.useRef<HTMLDivElement | null>(null);

  let ref = useForkedRef(forwardedRef as any, ownRef); // TODO: Fix in utils
  let triggerRect = useRect(ownRef, { observe: isVisible });

  React.useEffect(() => {
    return subscribe(() => {
      if (
        context.id === id &&
        (state === VISIBLE || state === LEAVING_VISIBLE)
      ) {
        setIsVisible(true);
      } else {
        setIsVisible(false);
      }
    });
  }, [id]);

  useCheckStyles("tooltip");

  React.useEffect(() => {
    let ownerDocument = getOwnerDocument(ownRef.current)!;
    function listener(event: KeyboardEvent) {
      if (
        (event.key === "Escape" || event.key === "Esc") &&
        state === VISIBLE
      ) {
        transition(SELECT_WITH_KEYBOARD);
      }
    }
    ownerDocument.addEventListener("keydown", listener);
    return () => ownerDocument.removeEventListener("keydown", listener);
  }, []);

  function handleMouseEnter() {
    transition(MOUSE_ENTER, { id });
  }

  function handleMouseMove() {
    transition(MOUSE_MOVE, { id });
  }

  function handleFocus() {
    // @ts-ignore
    if (window.__REACH_DISABLE_TOOLTIPS) {
      return;
    }
    transition(FOCUS, { id });
  }

  function handleMouseLeave() {
    transition(MOUSE_LEAVE);
  }

  function handleBlur() {
    // Allow quick click from one tool to another
    if (context.id !== id) return;
    transition(BLUR);
  }

  function handleMouseDown() {
    // Allow quick click from one tool to another
    if (context.id !== id) return;
    transition(MOUSE_DOWN);
  }

  function handleKeyDown(event: React.KeyboardEvent<T>) {
    if (event.key === "Enter" || event.key === " ") {
      transition(SELECT_WITH_KEYBOARD);
    }
  }

  let trigger: TriggerParams = {
    // The element that triggers the tooltip references the tooltip element with
    // `aria-describedby`.
    // https://www.w3.org/TR/wai-aria-practices-1.2/#tooltip
    "aria-describedby": isVisible ? makeId("tooltip", id) : undefined,
    "data-reach-tooltip-trigger": "",
    ref,
    onMouseEnter: wrapEvent(onMouseEnter, handleMouseEnter),
    onMouseMove: wrapEvent(onMouseMove, handleMouseMove),
    onFocus: wrapEvent(onFocus, handleFocus),
    onBlur: wrapEvent(onBlur, handleBlur),
    onMouseLeave: wrapEvent(onMouseLeave, handleMouseLeave),
    onKeyDown: wrapEvent(onKeyDown, handleKeyDown),
    onMouseDown: wrapEvent(onMouseDown, handleMouseDown),
  };

  let tooltip: TooltipParams = {
    id,
    triggerRect,
    isVisible,
  };

  return [trigger, tooltip, isVisible];
}

////////////////////////////////////////////////////////////////////////////////

/**
 * Tooltip
 *
 * @see Docs https://reach.tech/tooltip#tooltip
 */
const Tooltip = forwardRefWithAs<TooltipProps, "div">(function (
  {
    children,
    label,
    // TODO: Remove `ariaLabel` prop in 1.0 and just use `aria-label`
    ariaLabel: DEPRECATED_ariaLabel,
    id,
    DEBUG_STYLE,
    ...props
  },
  forwardedRef
) {
  let child = React.Children.only(children) as any;

  warning(
    !DEPRECATED_ariaLabel,
    "The `ariaLabel prop is deprecated and will be removed from @reach/tooltip in a future version of Reach UI. Please use `aria-label` instead."
  );

  // We need to pass some properties from the child into useTooltip
  // to make sure users can maintain control over the trigger's ref and events
  let [trigger, tooltip] = useTooltip({
    id,
    onMouseEnter: child.props.onMouseEnter,
    onMouseMove: child.props.onMouseMove,
    onMouseLeave: child.props.onMouseLeave,
    onFocus: child.props.onFocus,
    onBlur: child.props.onBlur,
    onKeyDown: child.props.onKeyDown,
    onMouseDown: child.props.onMouseDown,
    ref: child.ref,
    DEBUG_STYLE,
  });
  return (
    <React.Fragment>
      {React.cloneElement(child, trigger as any)}
      <TooltipPopup
        ref={forwardedRef}
        label={label}
        aria-label={DEPRECATED_ariaLabel}
        {...tooltip}
        {...props}
      />
    </React.Fragment>
  );
});

type TooltipProps = {
  children: React.ReactNode;
  DEBUG_STYLE?: boolean;
} & Omit<TooltipContentProps, "triggerRect" | "isVisible">;

if (__DEV__) {
  Tooltip.displayName = "Tooltip";
  Tooltip.propTypes = {
    children: PropTypes.node.isRequired,
    label: PropTypes.node.isRequired,
    ariaLabel: PropTypes.string,
  };
}

////////////////////////////////////////////////////////////////////////////////

/**
 * TooltipPopup
 *
 * @see Docs https://reach.tech/tooltip#tooltippopup
 */
const TooltipPopup = forwardRefWithAs<TooltipPopupProps, "div">(
  function TooltipPopup(
    {
      // could use children but we want to encourage simple strings
      label,
      // TODO: Remove `ariaLabel` prop in 1.0 and just use `aria-label`
      ariaLabel: DEPRECATED_ariaLabel,
      isVisible,
      id,
      ...props
    },
    forwardRef
  ) {
    return isVisible ? (
      <Portal>
        <TooltipContent
          ref={forwardRef}
          label={label}
          aria-label={DEPRECATED_ariaLabel}
          isVisible={isVisible}
          {...props}
          id={makeId("tooltip", String(id))}
        />
      </Portal>
    ) : null;
  }
);

type TooltipPopupProps = {
  children?: React.ReactNode;
} & TooltipContentProps;

if (__DEV__) {
  TooltipPopup.displayName = "TooltipPopup";
  TooltipPopup.propTypes = {
    label: PropTypes.node.isRequired,
    ariaLabel: PropTypes.string,
    position: PropTypes.func,
  };
}

/**
 * TooltipContent
 *
 * We need a separate component so that useRect works inside the portal.
 *
 * @see Docs https://reach.tech/tooltip#tooltipcontent
 */
const TooltipContent = forwardRefWithAs<TooltipContentProps, "div">(
  function TooltipContent(
    {
      // TODO: Remove `ariaLabel` prop in 1.0 and just use `aria-label`
      ariaLabel,
      "aria-label": realAriaLabel,
      as: Comp = "div",
      id,
      isVisible,
      label,
      position = positionTooltip,
      style,
      triggerRect,
      ...props
    },
    forwardedRef
  ) {
    // The element that serves as the tooltip container has role tooltip.
    // https://www.w3.org/TR/wai-aria-practices-1.2/#tooltip
    // When an app passes an `aria-label`, we actually want to implement
    // `role="tooltip"` on a visually hidden element inside of the trigger.
    // In these cases we want the screen reader user to know both the content in
    // the tooltip, but also the content in the badge. For screen reader users,
    // the only content announced to them is whatever is in the tooltip.
    let hasAriaLabel = (realAriaLabel || ariaLabel) != null;

    let ownRef = React.useRef(null);
    let ref = useForkedRef(forwardedRef, ownRef);
    let tooltipRect = useRect(ownRef, { observe: isVisible });
    return (
      <React.Fragment>
        <Comp
          role={hasAriaLabel ? undefined : "tooltip"}
          {...props}
          ref={ref}
          data-reach-tooltip=""
          id={hasAriaLabel ? undefined : id}
          style={{
            ...style,
            ...getStyles(position, triggerRect as PRect, tooltipRect as PRect),
          }}
        >
          {label}
        </Comp>
        {hasAriaLabel && (
          <VisuallyHidden role="tooltip" id={id}>
            {realAriaLabel || ariaLabel}
          </VisuallyHidden>
        )}
      </React.Fragment>
    );
  }
);

type TooltipContentProps = {
  ariaLabel?: string;
  position?: Position;
  label: React.ReactNode;
  isVisible?: boolean;
  triggerRect: DOMRect | null;
};

if (__DEV__) {
  TooltipContent.displayName = "TooltipContent";
  TooltipContent.propTypes = {};
}

////////////////////////////////////////////////////////////////////////////////

function getStyles(
  position: Position,
  triggerRect: PRect,
  tooltipRect: PRect
): React.CSSProperties {
  let haventMeasuredTooltipYet = !tooltipRect;
  if (haventMeasuredTooltipYet) {
    return { visibility: "hidden" };
  }
  return position(triggerRect, tooltipRect);
}

// Default offset from the trigger (e.g., if the tooltip is positioned above,
// there will be 8px between the bottom of the tooltip and the top of the trigger).
// It feels awkward when it's perfectly aligned w/ the trigger
const OFFSET_DEFAULT = 8;

export const positionTooltip: Position = (triggerRect, tooltipRect, offset = OFFSET_DEFAULT) => {
  let { width: windowWidth, height: windowHeight } = getDocumentDimensions();
  if (!triggerRect || !tooltipRect) {
    return {};
  }

  let collisions = {
    top: triggerRect.top - tooltipRect.height < 0,
    right: windowWidth < triggerRect.left + tooltipRect.width,
    bottom: windowHeight < triggerRect.bottom + tooltipRect.height + offset,
    left: triggerRect.left - tooltipRect.width < 0,
  };

  let directionRight = collisions.right && !collisions.left;
  let directionUp = collisions.bottom && !collisions.top;

  return {
    left: directionRight
      ? `${triggerRect.right - tooltipRect.width + window.pageXOffset}px`
      : `${triggerRect.left + window.pageXOffset}px`,
    top: directionUp
      ? `${
          triggerRect.top - offset - tooltipRect.height + window.pageYOffset
        }px`
      : `${
          triggerRect.top + offset + triggerRect.height + window.pageYOffset
        }px`,
  };
};

////////////////////////////////////////////////////////////////////////////////

/**
 * Finds the next state from the current state + action. If the chart doesn't
 * describe that transition, it will throw.
 *
 * It also manages lifecycles of the machine, (enter/leave hooks on the state
 * chart)
 *
 * @param event
 * @param payload
 */
const transition: Transition = (event, payload) => {
  let stateDef = chart.states[state];
  let nextState = stateDef && stateDef.on && stateDef.on[event];

  // Really useful for debugging
  // console.log({ event, state, nextState, contextId: context.id });
  // !nextState && console.log('no transition taken')

  if (!nextState) {
    return;
  }

  if (stateDef && stateDef.leave) {
    stateDef.leave();
  }

  if (payload) {
    context = payload;
  }

  let nextDef = chart.states[nextState];
  if (nextDef && nextDef.enter) {
    nextDef.enter();
  }

  state = nextState;
  notify();
};

////////////////////////////////////////////////////////////////////////////////
// TYPES

interface TriggerParams {
  "aria-describedby"?: string | undefined;
  "data-reach-tooltip-trigger": string;
  ref: React.Ref<any>;
  onMouseEnter: React.ReactEventHandler;
  onMouseMove: React.ReactEventHandler;
  onFocus: React.ReactEventHandler;
  onBlur: React.ReactEventHandler;
  onMouseLeave: React.ReactEventHandler;
  onKeyDown: React.ReactEventHandler;
  onMouseDown: React.ReactEventHandler;
}

interface TooltipParams {
  id: string;
  triggerRect: DOMRect | null;
  isVisible: boolean;
}

type Transition = (event: MachineEventType, payload?: any) => any;

type State = "IDLE" | "FOCUSED" | "VISIBLE" | "LEAVING_VISIBLE" | "DISMISSED";

type MachineEventType =
  | "BLUR"
  | "FOCUS"
  | "GLOBAL_MOUSE_MOVE"
  | "MOUSE_DOWN"
  | "MOUSE_ENTER"
  | "MOUSE_LEAVE"
  | "MOUSE_MOVE"
  | "REST"
  | "SELECT_WITH_KEYBOARD"
  | "TIME_COMPLETE";

interface StateChart {
  initial: State;
  states: {
    [key in State]?: {
      enter?: Function;
      leave?: Function;
      on: {
        [key in MachineEventType]?: State;
      };
    };
  };
}

type StateContext = {
  id?: string | null;
};

type Position = (
  targetRect?: PRect | null,
  popoverRect?: PRect | null
) => React.CSSProperties;

type PRect = Partial<DOMRect> & {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
};

////////////////////////////////////////////////////////////////////////////////
// Exports

export default Tooltip;
export type {
  Position,
  TooltipContentProps,
  TooltipParams,
  TooltipPopupProps,
  TooltipProps,
  TriggerParams,
};
export { MOUSE_REST_TIMEOUT, LEAVE_TIMEOUT, Tooltip, TooltipPopup, useTooltip };
